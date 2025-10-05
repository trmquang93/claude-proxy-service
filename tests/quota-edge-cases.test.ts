/**
 * Edge case tests for credit-only quota system
 * Tests boundary conditions, invalid values, and race conditions
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import pool from "../src/db";
import {
  checkQuotaLimit,
  calculateEffectiveLimit,
  getRollingWindowUsage,
  calculateUsagePercentage
} from "../src/quota";
import { PLAN_LIMITS } from "../src/limits";

describe("Quota System Edge Cases", () => {
  let testUserId: string;
  let testKeyId: string;

  beforeEach(async () => {
    const timestamp = Date.now();

    // Create test user
    await pool.query(
      "INSERT INTO users (id, email, password_hash, plan_type, created_at) VALUES ($1, $2, $3, $4, $5)",
      [`edge-user-${timestamp}`, `edge-test-${timestamp}@example.com`, "test-hash", "pro", Math.floor(timestamp / 1000)]
    );
    testUserId = `edge-user-${timestamp}`;

    // Create test API key
    await pool.query(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, quota_percentage, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [`edge-key-${timestamp}`, testUserId, "test-hash", "sk-test", "Edge Test Key", 100, Math.floor(timestamp / 1000)]
    );
    testKeyId = `edge-key-${timestamp}`;
  });

  afterEach(async () => {
    await pool.query("DELETE FROM api_key_usage_history WHERE key_id = $1", [testKeyId]);
    await pool.query("DELETE FROM api_key_usage WHERE key_id = $1", [testKeyId]);
    await pool.query("DELETE FROM api_keys WHERE id = $1", [testKeyId]);
    await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
  });

  describe("Boundary Conditions", () => {
    test("should handle exactly 100% usage correctly", async () => {
      const proLimit = PLAN_LIMITS.pro.creditsPerWindow; // 10M credits

      // Add usage exactly at limit
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 5_000_000, 5_000_000, proLimit, Date.now()]
      );

      const result = await checkQuotaLimit(testKeyId, "pro");

      expect(result.allowed).toBe(false);
      expect(result.percentages.creditPercentage).toBe(100);
      expect(result.percentages.isOverLimit).toBe(true);
    });

    test("should allow at 99.99% usage", async () => {
      const proLimit = PLAN_LIMITS.pro.creditsPerWindow;
      const almostLimit = proLimit - 1; // Just 1 credit below limit

      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 0, 0, almostLimit, Date.now()]
      );

      const result = await checkQuotaLimit(testKeyId, "pro");

      expect(result.allowed).toBe(true);
      expect(result.percentages.creditPercentage).toBe(100); // Rounds to 100
      expect(result.percentages.isOverLimit).toBe(false);
    });

    test("should block at 100.01% usage", async () => {
      const proLimit = PLAN_LIMITS.pro.creditsPerWindow;
      const overLimit = proLimit + 1; // Just 1 credit over limit

      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 0, 0, overLimit, Date.now()]
      );

      const result = await checkQuotaLimit(testKeyId, "pro");

      expect(result.allowed).toBe(false);
      expect(result.percentages.isOverLimit).toBe(true);
    });
  });

  describe("Invalid Quota Percentage Handling", () => {
    test("should handle NULL quota_percentage (default to 100%)", async () => {
      // Update key to have NULL quota_percentage
      await pool.query(
        "UPDATE api_keys SET quota_percentage = NULL WHERE id = $1",
        [testKeyId]
      );

      const proLimit = PLAN_LIMITS.pro.creditsPerWindow;

      // Add usage at 50% of plan limit
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 0, 0, proLimit / 2, Date.now()]
      );

      const result = await checkQuotaLimit(testKeyId, "pro");

      // Should treat as 100% and allow (50% usage < 100% limit)
      expect(result.allowed).toBe(true);
      expect(result.percentages.creditPercentage).toBe(50);
    });

    test("should handle very small quota_percentage (1%)", () => {
      const proLimit = PLAN_LIMITS.pro.creditsPerWindow; // 10M
      const effectiveLimit = calculateEffectiveLimit(proLimit, 1); // 1% = 100K

      expect(effectiveLimit).toBe(100_000);
    });

    test("should round down quota percentage calculations", () => {
      const limit = 1000;
      const percentage = 33; // 33% of 1000 = 330
      const effective = calculateEffectiveLimit(limit, percentage);

      expect(effective).toBe(330); // Not 330.something
    });
  });

  describe("Rolling Window Precision", () => {
    test("should handle usage exactly at window boundary", async () => {
      const now = Date.now();
      const windowHours = 5;
      const exactBoundary = now - (windowHours * 60 * 60 * 1000); // Exactly 5 hours ago

      // Add usage exactly at boundary
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 1000, 500, 1500, exactBoundary]
      );

      const usage = await getRollingWindowUsage(testKeyId, windowHours);

      // Should include usage exactly at boundary (>= comparison)
      expect(usage.currentCredits).toBe(1500);
    });

    test("should exclude usage 1ms before window", async () => {
      const now = Date.now();
      const windowHours = 5;
      const beforeWindow = now - (windowHours * 60 * 60 * 1000) - 1; // 5h + 1ms ago

      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 1000, 500, 1500, beforeWindow]
      );

      const usage = await getRollingWindowUsage(testKeyId, windowHours);

      // Should NOT include usage before window
      expect(usage.currentCredits).toBe(0);
    });
  });

  describe("Very Large Credit Values", () => {
    test("should handle very large credit values without overflow", async () => {
      const veryLargeCredits = 999_999_999_999; // Close to JS MAX_SAFE_INTEGER for credits

      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 0, 0, veryLargeCredits, Date.now()]
      );

      const usage = await getRollingWindowUsage(testKeyId, 5);

      expect(usage.currentCredits).toBe(veryLargeCredits);
      expect(Number.isSafeInteger(usage.currentCredits)).toBe(true);
    });

    test("should calculate percentage correctly with large numbers", () => {
      const usage = {
        currentCredits: 9_500_000_000, // 9.5 billion credits
        currentRequests: 1000,
        currentCost: 0,
        oldestRequestTimestamp: Date.now(),
        windowStartTime: Date.now() - 24 * 60 * 60 * 1000,
        windowEndTime: Date.now(),
        nextResetAt: Date.now() + 60 * 60 * 1000,
        timeUntilResetMs: 60 * 60 * 1000,
        modelBreakdown: []
      };

      const percentages = calculateUsagePercentage(usage, "pro"); // 10M limit

      expect(percentages.creditPercentage).toBe(95000); // 9.5B / 10M * 100
      expect(percentages.isOverLimit).toBe(true);
    });
  });

  describe("Mixed Model Weights in Same Window", () => {
    test("should correctly sum credits from different weighted models", async () => {
      const now = Date.now();

      // Opus: 1000 tokens * 5.0 = 5000 credits
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-opus-4-20250514", 500, 500, 5000, now]
      );

      // Sonnet: 1000 tokens * 1.0 = 1000 credits
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 500, 500, 1000, now]
      );

      // Haiku: 1000 tokens * 0.25 = 250 credits
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-haiku-4-20250514", 500, 500, 250, now]
      );

      const usage = await getRollingWindowUsage(testKeyId, 5);

      expect(usage.currentCredits).toBe(6250); // 5000 + 1000 + 250
      expect(usage.currentRequests).toBe(3);
    });
  });

  describe("Empty Usage History", () => {
    test("should handle key with no usage (all plans)", async () => {
      const plans = ["free", "pro", "max-5x", "max-20x"] as const;

      for (const plan of plans) {
        const result = await checkQuotaLimit(testKeyId, plan);

        expect(result.allowed).toBe(true);
        expect(result.usage.currentCredits).toBe(0);
        expect(result.percentages.creditPercentage).toBe(0);
        expect(result.percentages.isOverLimit).toBe(false);
      }
    });
  });

  describe("Quota Percentage with Different Plan Types", () => {
    test("should calculate effective limits correctly for all plan+percentage combinations", () => {
      const testCases = [
        { plan: "free", percentage: 50, expected: 5_000 },       // 10K * 50% = 5K
        { plan: "pro", percentage: 20, expected: 2_000_000 },    // 10M * 20% = 2M
        { plan: "max-5x", percentage: 10, expected: 5_000_000 }, // 50M * 10% = 5M
        { plan: "max-20x", percentage: 5, expected: 10_000_000 } // 200M * 5% = 10M
      ];

      for (const testCase of testCases) {
        const planLimit = PLAN_LIMITS[testCase.plan as keyof typeof PLAN_LIMITS].creditsPerWindow;
        const effective = calculateEffectiveLimit(planLimit, testCase.percentage);

        expect(effective).toBe(testCase.expected);
      }
    });
  });
});
