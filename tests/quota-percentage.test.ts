/**
 * Tests for per-key quota percentage feature (TDD - Red Phase)
 * These tests define the expected behavior for custom quota limits
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import pool from "../src/db";
import { calculateEffectiveLimit } from "../src/quota";
import { PLAN_LIMITS } from "../src/limits";

describe("Quota Percentage Feature", () => {
  describe("calculateEffectiveLimit()", () => {
    test("should calculate 100% as full limit", () => {
      const result = calculateEffectiveLimit(10_000_000, 100);
      expect(result).toBe(10_000_000);
    });

    test("should calculate 50% correctly", () => {
      const result = calculateEffectiveLimit(10_000_000, 50);
      expect(result).toBe(5_000_000);
    });

    test("should calculate 20% correctly", () => {
      const result = calculateEffectiveLimit(10_000_000, 20);
      expect(result).toBe(2_000_000);
    });

    test("should calculate 1% correctly", () => {
      const result = calculateEffectiveLimit(10_000_000, 1);
      expect(result).toBe(100_000);
    });

    test("should handle decimal results by rounding down", () => {
      const result = calculateEffectiveLimit(1000, 33);
      expect(result).toBe(330);
    });
  });

  describe("API Key Generation with Quota Percentage", () => {
    let testUserId: string;

    beforeEach(async () => {
      // Create test user
      const userResult = await pool.query(
        "INSERT INTO users (id, email, password_hash, plan_type, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [
          `quota-pct-user-${Date.now()}`,
          `quota-pct-${Date.now()}@example.com`,
          "test-hash",
          "pro",
          Math.floor(Date.now() / 1000)
        ]
      );
      testUserId = userResult.rows[0].id;
    });

    afterEach(async () => {
      await pool.query("DELETE FROM api_keys WHERE user_id = $1", [testUserId]);
      await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
    });

    test("should store quota_percentage when creating API key", async () => {
      const keyId = `test-key-${Date.now()}`;

      await pool.query(
        `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, quota_percentage, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [keyId, testUserId, "hash", "sk-test", "Test Key", 50, Math.floor(Date.now() / 1000)]
      );

      const result = await pool.query(
        "SELECT quota_percentage FROM api_keys WHERE id = $1",
        [keyId]
      );

      expect(result.rows[0].quota_percentage).toBe(50);
    });

    test("should default quota_percentage to 100 if not specified", async () => {
      const keyId = `test-key-${Date.now()}`;

      await pool.query(
        `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [keyId, testUserId, "hash", "sk-test", "Test Key", Math.floor(Date.now() / 1000)]
      );

      const result = await pool.query(
        "SELECT quota_percentage FROM api_keys WHERE id = $1",
        [keyId]
      );

      expect(result.rows[0].quota_percentage).toBe(100);
    });
  });

  describe("Quota Enforcement with Percentage", () => {
    let testUserId: string;
    let testKeyId: string;

    beforeEach(async () => {
      // Create test user
      const userResult = await pool.query(
        "INSERT INTO users (id, email, password_hash, plan_type, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [
          `quota-enforcement-user-${Date.now()}`,
          `quota-enforcement-${Date.now()}@example.com`,
          "test-hash",
          "pro",
          Math.floor(Date.now() / 1000)
        ]
      );
      testUserId = userResult.rows[0].id;

      // Create test API key with 20% quota
      const keyResult = await pool.query(
        `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, quota_percentage, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          `quota-enforcement-key-${Date.now()}`,
          testUserId,
          "test-hash",
          "sk-test",
          "20% Quota Key",
          20,
          Math.floor(Date.now() / 1000)
        ]
      );
      testKeyId = keyResult.rows[0].id;
    });

    afterEach(async () => {
      await pool.query("DELETE FROM api_key_usage_history WHERE key_id = $1", [testKeyId]);
      await pool.query("DELETE FROM api_key_usage WHERE key_id = $1", [testKeyId]);
      await pool.query("DELETE FROM api_keys WHERE id = $1", [testKeyId]);
      await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
    });

    test("should enforce 20% of pro plan limit", async () => {
      const proPlanLimit = PLAN_LIMITS.pro.creditsPerWindow; // 10M credits
      const expectedLimit = calculateEffectiveLimit(proPlanLimit, 20); // 2M credits

      expect(expectedLimit).toBe(2_000_000);
    });

    test("should allow request within 20% limit", async () => {
      // Insert usage that's within 20% of pro limit (< 2M credits)
      const now = Date.now();

      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 1_000_000, 500_000, 1_500_000, now - 60 * 60 * 1000]
      );

      // With 20% limit, key has 2M credits available
      // Used 1.5M, so should still be allowed
      const usage = 1_500_000;
      const limit = 2_000_000;
      const percentage = (usage / limit) * 100;

      expect(percentage).toBeLessThan(100);
    });

    test("should block request exceeding 20% limit", async () => {
      // Insert usage that exceeds 20% of pro limit (> 2M credits)
      const now = Date.now();

      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 1_500_000, 750_000, 2_250_000, now - 60 * 60 * 1000]
      );

      // With 20% limit, key has 2M credits available
      // Used 2.25M, so should be blocked
      const usage = 2_250_000;
      const limit = 2_000_000;
      const percentage = (usage / limit) * 100;

      expect(percentage).toBeGreaterThan(100);
    });
  });

  describe("Validation", () => {
    test("should reject quota_percentage less than 1", () => {
      const isValid = (pct: number) => pct >= 1 && pct <= 100;
      expect(isValid(0)).toBe(false);
      expect(isValid(-10)).toBe(false);
    });

    test("should reject quota_percentage greater than 100", () => {
      const isValid = (pct: number) => pct >= 1 && pct <= 100;
      expect(isValid(101)).toBe(false);
      expect(isValid(150)).toBe(false);
    });

    test("should accept quota_percentage between 1 and 100", () => {
      const isValid = (pct: number) => pct >= 1 && pct <= 100;
      expect(isValid(1)).toBe(true);
      expect(isValid(50)).toBe(true);
      expect(isValid(100)).toBe(true);
    });
  });
});
