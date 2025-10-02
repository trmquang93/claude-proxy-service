import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { updateKeyUsage, getKeyUsage } from "../src/usage";
import { randomUUID } from "crypto";
import pool from "../src/db";

describe("Usage Module with Dynamic Pricing", () => {
  let testKeyId: string;
  const testUserId = "test-user-pricing";

  beforeEach(async () => {
    // Create test user if not exists
    await pool.query(
      `INSERT INTO users (id, email, password_hash, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [testUserId, "test@pricing.com", "hash", Date.now()]
    );

    // Create a fresh test key for each test
    testKeyId = `test-key-${randomUUID()}`;

    // Insert into api_keys table first
    await pool.query(
      `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [testKeyId, testUserId, `hash-${testKeyId}`, "test-", "Test Key", Date.now()]
    );

    // Then insert into api_key_usage table
    await pool.query(
      `INSERT INTO api_key_usage (key_id) VALUES ($1)`,
      [testKeyId]
    );
  });

  afterAll(async () => {
    // Clean up test data (cascade will handle api_key_usage)
    await pool.query("DELETE FROM api_keys WHERE key_prefix = 'test-'");
    await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
  });

  describe("updateKeyUsage with Opus model", () => {
    test("should calculate correct cost for Opus with basic tokens", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-opus-4-20250514",
        input_tokens: 10000,
        output_tokens: 5000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      const usage = await getKeyUsage(testKeyId);
      expect(usage).not.toBeNull();

      // Input: 10000 * $15/MTok = 0.15
      // Output: 5000 * $75/MTok = 0.375
      // Total: 0.525
      expect(usage!.total_cost).toBeCloseTo(0.525, 3);
      expect(usage!.input_tokens).toBe(10000);
      expect(usage!.output_tokens).toBe(5000);
      expect(usage!.total_tokens).toBe(15000);
      expect(usage!.request_count).toBe(1);
    });

    test("should calculate correct cost for Opus with cache tokens", async () => {
      await updateKeyUsage(testKeyId, {
        model: "opus-4.1",
        input_tokens: 10000,
        output_tokens: 5000,
        cache_creation_input_tokens: 20000,
        cache_read_input_tokens: 30000,
      });

      const usage = await getKeyUsage(testKeyId);

      // Input: 10000 * $15/MTok = 0.15
      // Output: 5000 * $75/MTok = 0.375
      // Cache Write: 20000 * $18.75/MTok = 0.375
      // Cache Read: 30000 * $1.50/MTok = 0.045
      // Total: 0.945
      expect(usage!.total_cost).toBeCloseTo(0.945, 3);
      expect(usage!.cache_creation_tokens).toBe(20000);
      expect(usage!.cache_read_tokens).toBe(30000);
      expect(usage!.total_tokens).toBe(65000);
    });
  });

  describe("updateKeyUsage with Sonnet model (≤200K)", () => {
    test("should calculate correct cost for Sonnet with small context", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-sonnet-4-20250514",
        input_tokens: 50000,
        output_tokens: 10000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      const usage = await getKeyUsage(testKeyId);

      // Context: 50000 tokens (≤200K)
      // Input: 50000 * $3/MTok = 0.15
      // Output: 10000 * $15/MTok = 0.15
      // Total: 0.3
      expect(usage!.total_cost).toBeCloseTo(0.3, 3);
      expect(usage!.input_tokens).toBe(50000);
      expect(usage!.output_tokens).toBe(10000);
    });

    test("should calculate correct cost for Sonnet with cache at 200K threshold", async () => {
      await updateKeyUsage(testKeyId, {
        model: "sonnet",
        input_tokens: 150000,
        output_tokens: 10000,
        cache_creation_input_tokens: 30000,
        cache_read_input_tokens: 20000,
      });

      const usage = await getKeyUsage(testKeyId);

      // Context: 150000 + 30000 + 20000 = 200000 (exactly at threshold, uses ≤200K pricing)
      // Input: 150000 * $3/MTok = 0.45
      // Output: 10000 * $15/MTok = 0.15
      // Cache Write: 30000 * $3.75/MTok = 0.1125
      // Cache Read: 20000 * $0.30/MTok = 0.006
      // Total: 0.7185
      expect(usage!.total_cost).toBeCloseTo(0.7185, 3);
    });
  });

  describe("updateKeyUsage with Sonnet model (>200K)", () => {
    test("should calculate correct cost for Sonnet with large context", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-sonnet-4-20250514",
        input_tokens: 250000,
        output_tokens: 50000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      const usage = await getKeyUsage(testKeyId);

      // Context: 250000 tokens (>200K)
      // Input: 250000 * $6/MTok = 1.5
      // Output: 50000 * $22.50/MTok = 1.125
      // Total: 2.625
      expect(usage!.total_cost).toBeCloseTo(2.625, 3);
    });

    test("should calculate correct cost for Sonnet with cache over 200K", async () => {
      await updateKeyUsage(testKeyId, {
        model: "sonnet",
        input_tokens: 150000,
        output_tokens: 20000,
        cache_creation_input_tokens: 100000,
        cache_read_input_tokens: 50000,
      });

      const usage = await getKeyUsage(testKeyId);

      // Context: 150000 + 100000 + 50000 = 300000 (>200K)
      // Input: 150000 * $6/MTok = 0.9
      // Output: 20000 * $22.50/MTok = 0.45
      // Cache Write: 100000 * $7.50/MTok = 0.75
      // Cache Read: 50000 * $0.60/MTok = 0.03
      // Total: 2.13
      expect(usage!.total_cost).toBeCloseTo(2.13, 3);
    });
  });

  describe("updateKeyUsage - Cumulative usage", () => {
    test("should accumulate costs across multiple requests with different models", async () => {
      // First request: Sonnet small context
      await updateKeyUsage(testKeyId, {
        model: "sonnet",
        input_tokens: 10000,
        output_tokens: 5000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      // Second request: Opus
      await updateKeyUsage(testKeyId, {
        model: "opus",
        input_tokens: 10000,
        output_tokens: 5000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      const usage = await getKeyUsage(testKeyId);

      // First cost: (10000 * $3 + 5000 * $15) / 1M = 0.105
      // Second cost: (10000 * $15 + 5000 * $75) / 1M = 0.525
      // Total: 0.63
      expect(usage!.total_cost).toBeCloseTo(0.63, 3);
      expect(usage!.input_tokens).toBe(20000);
      expect(usage!.output_tokens).toBe(10000);
      expect(usage!.total_tokens).toBe(30000);
      expect(usage!.request_count).toBe(2);
    });

    test("should accumulate correctly when crossing 200K threshold across requests", async () => {
      // First request: 150K context (≤200K)
      await updateKeyUsage(testKeyId, {
        model: "sonnet",
        input_tokens: 150000,
        output_tokens: 10000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      const usage1 = await getKeyUsage(testKeyId);
      // Cost: (150000 * $3 + 10000 * $15) / 1M = 0.6
      expect(usage1!.total_cost).toBeCloseTo(0.6, 3);

      // Second request: 100K context (still ≤200K per request)
      await updateKeyUsage(testKeyId, {
        model: "sonnet",
        input_tokens: 100000,
        output_tokens: 5000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      const usage2 = await getKeyUsage(testKeyId);
      // Cost: (100000 * $3 + 5000 * $15) / 1M = 0.375
      // Total: 0.6 + 0.375 = 0.975
      expect(usage2!.total_cost).toBeCloseTo(0.975, 3);
      expect(usage2!.request_count).toBe(2);
    });
  });

  describe("updateKeyUsage - Model fallback", () => {
    test("should fallback to Sonnet pricing for unknown models", async () => {
      await updateKeyUsage(testKeyId, {
        model: "unknown-model",
        input_tokens: 10000,
        output_tokens: 5000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      const usage = await getKeyUsage(testKeyId);

      // Should use Sonnet ≤200K pricing
      // Input: 10000 * $3/MTok = 0.03
      // Output: 5000 * $15/MTok = 0.075
      // Total: 0.105
      expect(usage!.total_cost).toBeCloseTo(0.105, 3);
    });

    test("should fallback to Sonnet pricing for empty model name", async () => {
      await updateKeyUsage(testKeyId, {
        model: "",
        input_tokens: 10000,
        output_tokens: 5000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      const usage = await getKeyUsage(testKeyId);
      expect(usage!.total_cost).toBeCloseTo(0.105, 3);
    });
  });

  describe("updateKeyUsage - Edge cases", () => {
    test("should handle requests with zero tokens", async () => {
      await updateKeyUsage(testKeyId, {
        model: "sonnet",
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });

      const usage = await getKeyUsage(testKeyId);
      expect(usage!.total_cost).toBe(0);
      expect(usage!.request_count).toBe(1);
    });

    test("should handle undefined cache tokens", async () => {
      await updateKeyUsage(testKeyId, {
        model: "opus",
        input_tokens: 1000,
        output_tokens: 500,
      });

      const usage = await getKeyUsage(testKeyId);

      // Should calculate without errors
      // Input: 1000 * $15/MTok = 0.015
      // Output: 500 * $75/MTok = 0.0375
      // Total: 0.0525
      expect(usage!.total_cost).toBeCloseTo(0.0525, 4);
      expect(usage!.cache_creation_tokens).toBe(0);
      expect(usage!.cache_read_tokens).toBe(0);
    });
  });
});
