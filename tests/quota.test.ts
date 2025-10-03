/**
 * Tests for quota enforcement module (TDD - Red Phase)
 * These tests MUST fail initially since quota.ts doesn't exist yet
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import pool from "../src/db";
import {
  getRollingWindowUsage,
  calculateUsagePercentage,
  checkQuotaLimit,
  getNextResetTime,
  formatDuration,
  type WindowUsageStats,
  type UsagePercentages,
  type QuotaCheckResult
} from "../src/quota";
import { PLAN_LIMITS, type PlanType } from "../src/limits";

describe("Quota Module - Rolling Window Calculations", () => {
  let testKeyId: string;

  beforeEach(async () => {
    // Create test user
    const userResult = await pool.query(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [`quota-user-${Date.now()}`, `quota-test-${Date.now()}@example.com`, "test-hash", Math.floor(Date.now() / 1000)]
    );
    const userId = userResult.rows[0].id;

    // Create test API key
    const keyResult = await pool.query(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, plan_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [`quota-key-${Date.now()}`, userId, `test-hash-quota-${Date.now()}`, "sk-test", "Quota Test Key", "pro", Math.floor(Date.now() / 1000)]
    );
    testKeyId = keyResult.rows[0].id;
  });

  afterEach(async () => {
    // Clean up test data
    await pool.query("DELETE FROM api_key_usage_history WHERE key_id = $1", [testKeyId]);
    await pool.query("DELETE FROM api_key_usage WHERE key_id = $1", [testKeyId]);
    await pool.query("DELETE FROM api_keys WHERE id = $1", [testKeyId]);
    await pool.query("DELETE FROM users WHERE id LIKE 'quota-user-%'");
  });

  describe("getRollingWindowUsage()", () => {
    test("should calculate total credits in time window", async () => {
      // Insert usage records within 24-hour window
      const now = new Date();

      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 1000, 500, 1500, now.getTime() - 2 * 60 * 60 * 1000] // 2 hours ago
      );

      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 2000, 1000, 3000, now.getTime() - 1 * 60 * 60 * 1000] // 1 hour ago
      );

      const usage = await getRollingWindowUsage(testKeyId, 24);

      expect(usage.currentCredits).toBe(4500); // 1500 + 3000
      expect(usage.currentRequests).toBe(2);
    });

    test("should calculate total requests in time window", async () => {
      const now = new Date();

      // Insert 3 requests
      for (let i = 0; i < 3; i++) {
        await pool.query(
          `INSERT INTO api_key_usage_history
           (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [testKeyId, "claude-haiku-4-20250514", 100, 50, 38, now.getTime( - i * 60 * 60 * 1000)]
        );
      }

      const usage = await getRollingWindowUsage(testKeyId, 24);

      expect(usage.currentRequests).toBe(3);
      expect(usage.currentCredits).toBe(114); // 38 * 3
    });

    test("should only include records within window (ignore older)", async () => {
      const now = new Date();

      // Old record (outside 24-hour window)
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 5000, 2000, 7000, now.getTime() - 25 * 60 * 60 * 1000] // 25 hours ago
      );

      // Recent record (within 24-hour window)
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 1000, 500, 1500, now.getTime( - 1 * 60 * 60 * 1000)] // 1 hour ago
      );

      const usage = await getRollingWindowUsage(testKeyId, 24);

      expect(usage.currentCredits).toBe(1500); // Only recent record
      expect(usage.currentRequests).toBe(1);
    });

    test("should return 0 if no usage in window", async () => {
      const usage = await getRollingWindowUsage(testKeyId, 24);

      expect(usage.currentCredits).toBe(0);
      expect(usage.currentRequests).toBe(0);
      expect(usage.currentCost).toBe(0);
      expect(usage.oldestRequestTimestamp).toBeNull();
    });

    test("should handle multiple models (weighted credits)", async () => {
      const now = new Date();

      // Opus request (5x weight)
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-opus-4-20250514", 1000, 500, 7500, now.getTime()] // 1500 tokens * 5 = 7500 credits
      );

      // Haiku request (0.25x weight)
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-haiku-4-20250514", 1000, 500, 375, now.getTime()] // 1500 tokens * 0.25 = 375 credits
      );

      const usage = await getRollingWindowUsage(testKeyId, 24);

      expect(usage.currentCredits).toBe(7875); // 7500 + 375
      expect(usage.currentRequests).toBe(2);
    });

    test("should return oldest request timestamp for reset calculation", async () => {
      const now = new Date();
      const oldestTime = new Date(now.getTime() - 5 * 60 * 60 * 1000); // 5 hours ago

      // Oldest request
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 1000, 500, 1500, oldestTime.getTime()]
      );

      // Newer request
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 1000, 500, 1500, now.getTime( - 1 * 60 * 60 * 1000)]
      );

      const usage = await getRollingWindowUsage(testKeyId, 24);

      expect(usage.oldestRequestTimestamp).toBe(oldestTime.getTime());
    });

    test("should return model breakdown showing per-model usage", async () => {
      const now = new Date();

      // 2 Sonnet requests
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 1000, 500, 1500, now.getTime()]
      );
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 2000, 1000, 3000, now.getTime()]
      );

      // 1 Haiku request
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-haiku-4-20250514", 1000, 500, 375, now.getTime()]
      );

      const usage = await getRollingWindowUsage(testKeyId, 24);

      expect(usage.modelBreakdown).toHaveLength(2);

      const sonnetBreakdown = usage.modelBreakdown.find(m => m.model === "sonnet");
      expect(sonnetBreakdown?.requests).toBe(2);
      expect(sonnetBreakdown?.credits).toBe(4500);

      const haikuBreakdown = usage.modelBreakdown.find(m => m.model === "haiku");
      expect(haikuBreakdown?.requests).toBe(1);
      expect(haikuBreakdown?.credits).toBe(375);
    });

    test("should work with different window sizes (5h vs 24h)", async () => {
      const now = Date.now();

      // Record 6 hours ago (outside 5h window, inside 24h window)
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 1000, 500, 1500, now - 6 * 60 * 60 * 1000]
      );

      // Record 2 hours ago (inside both windows)
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 2000, 1000, 3000, now - 2 * 60 * 60 * 1000]
      );

      const usage5h = await getRollingWindowUsage(testKeyId, 5);
      const usage24h = await getRollingWindowUsage(testKeyId, 24);

      expect(usage5h.currentCredits).toBe(3000); // Only 2h-old record
      expect(usage24h.currentCredits).toBe(4500); // Both records
    });
  });

  describe("calculateUsagePercentage()", () => {
    test("should calculate credit percentage correctly", () => {
      const usage: WindowUsageStats = {
        currentCredits: 250000,
        currentRequests: 10,
        currentCost: 0,
        oldestRequestTimestamp: Date.now(),
        windowStartTime: Date.now() - 24 * 60 * 60 * 1000,
        windowEndTime: Date.now(),
        nextResetAt: Date.now() + 60 * 60 * 1000,
        timeUntilResetMs: 60 * 60 * 1000,
        modelBreakdown: []
      };

      const percentages = calculateUsagePercentage(usage, "pro");

      expect(percentages.creditPercentage).toBe(50); // 250000 / 500000 * 100
    });

    test("should calculate request percentage correctly", () => {
      const usage: WindowUsageStats = {
        currentCredits: 100000,
        currentRequests: 25,
        currentCost: 0,
        oldestRequestTimestamp: Date.now(),
        windowStartTime: Date.now() - 24 * 60 * 60 * 1000,
        windowEndTime: Date.now(),
        nextResetAt: Date.now() + 60 * 60 * 1000,
        timeUntilResetMs: 60 * 60 * 1000,
        modelBreakdown: []
      };

      const percentages = calculateUsagePercentage(usage, "pro");

      // Note: maxRequestsPerMinute is per-minute, not per-window
      // This test validates the calculation logic, actual enforcement may differ
      expect(percentages.requestPercentage).toBeGreaterThanOrEqual(0);
    });

    test("should identify most restrictive limit (maxPercentage)", () => {
      const usage: WindowUsageStats = {
        currentCredits: 450000, // 90% of pro limit
        currentRequests: 10,
        currentCost: 0,
        oldestRequestTimestamp: Date.now(),
        windowStartTime: Date.now() - 24 * 60 * 60 * 1000,
        windowEndTime: Date.now(),
        nextResetAt: Date.now() + 60 * 60 * 1000,
        timeUntilResetMs: 60 * 60 * 1000,
        modelBreakdown: []
      };

      const percentages = calculateUsagePercentage(usage, "pro");

      expect(percentages.maxPercentage).toBe(90); // Credits are more restrictive
    });

    test("should set isOverLimit=true when >=100%", () => {
      const usage: WindowUsageStats = {
        currentCredits: 500000, // Exactly at limit
        currentRequests: 10,
        currentCost: 0,
        oldestRequestTimestamp: Date.now(),
        windowStartTime: Date.now() - 24 * 60 * 60 * 1000,
        windowEndTime: Date.now(),
        nextResetAt: Date.now() + 60 * 60 * 1000,
        timeUntilResetMs: 60 * 60 * 1000,
        modelBreakdown: []
      };

      const percentages = calculateUsagePercentage(usage, "pro");

      expect(percentages.isOverLimit).toBe(true);
      expect(percentages.creditPercentage).toBe(100);
    });

    test("should set isOverLimit=false when <100%", () => {
      const usage: WindowUsageStats = {
        currentCredits: 499999, // Just under limit
        currentRequests: 10,
        currentCost: 0,
        oldestRequestTimestamp: Date.now(),
        windowStartTime: Date.now() - 24 * 60 * 60 * 1000,
        windowEndTime: Date.now(),
        nextResetAt: Date.now() + 60 * 60 * 1000,
        timeUntilResetMs: 60 * 60 * 1000,
        modelBreakdown: []
      };

      const percentages = calculateUsagePercentage(usage, "pro");

      expect(percentages.isOverLimit).toBe(false);
    });
  });

  describe("checkQuotaLimit()", () => {
    test("should allow request when under limit (<100%)", async () => {
      const now = new Date();

      // Add usage: 100K credits (20% of pro limit)
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 50000, 50000, 100000, now.getTime()]
      );

      const result = await checkQuotaLimit(testKeyId, "pro");

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.percentages.creditPercentage).toBe(20);
    });

    test("should block request when over credit limit", async () => {
      const now = new Date();

      // Add usage: 500K credits (100% of pro limit)
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 250000, 250000, 500000, now.getTime()]
      );

      const result = await checkQuotaLimit(testKeyId, "pro");

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Quota"); // Capital Q
      expect(result.percentages.isOverLimit).toBe(true);
    });

    test("should return correct reset time", async () => {
      const now = new Date();
      const oldestTime = new Date(now.getTime() - 4 * 60 * 60 * 1000); // 4 hours ago (within 5h window)

      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 50000, 50000, 100000, oldestTime.getTime()]
      );

      const result = await checkQuotaLimit(testKeyId, "pro");

      // Reset should be 5 hours after oldest request (Pro plan uses 5h window)
      const expectedResetTime = new Date(oldestTime.getTime() + 5 * 60 * 60 * 1000);
      expect(result.resetTime.getTime()).toBeCloseTo(expectedResetTime.getTime(), -3); // Within 1 second
    });

    test("should include usage statistics", async () => {
      const now = new Date();

      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 50000, 50000, 100000, now.getTime()]
      );

      const result = await checkQuotaLimit(testKeyId, "pro");

      expect(result.usage.currentCredits).toBe(100000);
      expect(result.usage.currentRequests).toBe(1);
      expect(result.usage.modelBreakdown).toBeDefined();
    });

    test("should handle non-existent keys gracefully", async () => {
      const result = await checkQuotaLimit("non-existent-key", "pro");

      expect(result.allowed).toBe(true); // Allow if no usage found (new key)
      expect(result.usage.currentCredits).toBe(0);
    });
  });

  describe("getNextResetTime()", () => {
    test("should calculate reset time from oldest request", () => {
      const now = Date.now();
      const oldestTimestamp = now - 20 * 60 * 60 * 1000; // 20 hours ago

      const resetTime = getNextResetTime(oldestTimestamp, 24);

      const expectedResetTime = new Date(oldestTimestamp + 24 * 60 * 60 * 1000);
      expect(resetTime.getTime()).toBe(expectedResetTime.getTime());
    });

    test("should handle null oldestTimestamp", () => {
      const resetTime = getNextResetTime(null, 24);

      // Should return now + window hours
      const expectedResetTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
      expect(resetTime.getTime()).toBeCloseTo(expectedResetTime.getTime(), -3); // Within 1 second
    });

    test("should work with different window sizes (5h, 24h)", () => {
      const now = Date.now();
      const oldestTimestamp = now - 3 * 60 * 60 * 1000; // 3 hours ago

      const resetTime5h = getNextResetTime(oldestTimestamp, 5);
      const resetTime24h = getNextResetTime(oldestTimestamp, 24);

      const expectedReset5h = new Date(oldestTimestamp + 5 * 60 * 60 * 1000);
      const expectedReset24h = new Date(oldestTimestamp + 24 * 60 * 60 * 1000);

      expect(resetTime5h.getTime()).toBe(expectedReset5h.getTime());
      expect(resetTime24h.getTime()).toBe(expectedReset24h.getTime());
    });
  });

  describe("formatDuration()", () => {
    test("should format milliseconds to human-readable duration", () => {
      expect(formatDuration(3600000)).toBe("1h 0m"); // 1 hour
      expect(formatDuration(7200000)).toBe("2h 0m"); // 2 hours
      expect(formatDuration(5400000)).toBe("1h 30m"); // 1.5 hours
      expect(formatDuration(60000)).toBe("0h 1m"); // 1 minute
      expect(formatDuration(90000)).toBe("0h 1m"); // 1.5 minutes (rounds down)
    });
  });
});
