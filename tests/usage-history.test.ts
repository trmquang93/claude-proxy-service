import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import pool from "../src/db";
import { updateKeyUsage, initializeKeyUsage } from "../src/usage";
import { randomUUID } from "crypto";

describe("Usage History Tracking", () => {
  let testKeyId: string;
  let testUserId: string;

  beforeAll(async () => {
    // Generate unique IDs
    testUserId = randomUUID();
    testKeyId = randomUUID();

    // Cleanup any existing test data first
    await pool.query(`DELETE FROM api_key_usage_history WHERE key_id = $1`, [testKeyId]);
    await pool.query(`DELETE FROM api_key_usage WHERE key_id = $1`, [testKeyId]);
    await pool.query(`DELETE FROM api_keys WHERE id = $1`, [testKeyId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]);

    // Create test user
    await pool.query(
      `INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)`,
      [testUserId, `test-usage-history-${Date.now()}@example.com`, "hash", Math.floor(Date.now() / 1000)]
    );

    // Create test API key with unique hash
    await pool.query(
      `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [testKeyId, testUserId, `test_hash_${testKeyId}`, "sk-test", Math.floor(Date.now() / 1000)]
    );

    // Initialize usage tracking
    await initializeKeyUsage(testKeyId);
  });

  afterAll(async () => {
    // Cleanup
    await pool.query(`DELETE FROM api_key_usage_history WHERE key_id = $1`, [testKeyId]);
    await pool.query(`DELETE FROM api_key_usage WHERE key_id = $1`, [testKeyId]);
    await pool.query(`DELETE FROM api_keys WHERE id = $1`, [testKeyId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
  });

  beforeEach(async () => {
    // Clear history before each test
    await pool.query(`DELETE FROM api_key_usage_history WHERE key_id = $1`, [testKeyId]);
    // Reset aggregate usage
    await pool.query(
      `UPDATE api_key_usage SET
        input_tokens = 0, output_tokens = 0,
        cache_creation_tokens = 0, cache_read_tokens = 0,
        total_tokens = 0, total_cost = 0, request_count = 0
       WHERE key_id = $1`,
      [testKeyId]
    );
  });

  describe("updateKeyUsage() - History Recording", () => {
    test("should insert record into api_key_usage_history with timestamp", async () => {
      const beforeTimestamp = Date.now();

      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 1000,
        output_tokens: 500,
      });

      const afterTimestamp = Date.now();

      const result = await pool.query(
        `SELECT * FROM api_key_usage_history WHERE key_id = $1`,
        [testKeyId]
      );

      expect(result.rows.length).toBe(1);
      const record = result.rows[0];

      // Timestamp should be within test execution window
      expect(Number(record.timestamp)).toBeGreaterThanOrEqual(beforeTimestamp);
      expect(Number(record.timestamp)).toBeLessThanOrEqual(afterTimestamp);
    });

    test("should calculate and store credits using model weights", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 1000,
        output_tokens: 500,
      });

      const result = await pool.query(
        `SELECT credits_used FROM api_key_usage_history WHERE key_id = $1`,
        [testKeyId]
      );

      // Sonnet weight = 1.0, total tokens = 1500, credits = 1500 * 1.0 = 1500
      expect(Number(result.rows[0].credits_used)).toBe(1500);
    });

    test("should store all token counts correctly", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 100,
      });

      const result = await pool.query(
        `SELECT input_tokens, output_tokens, cache_creation_tokens,
                cache_read_tokens, total_tokens
         FROM api_key_usage_history WHERE key_id = $1`,
        [testKeyId]
      );

      const record = result.rows[0];
      expect(Number(record.input_tokens)).toBe(1000);
      expect(Number(record.output_tokens)).toBe(500);
      expect(Number(record.cache_creation_tokens)).toBe(200);
      expect(Number(record.cache_read_tokens)).toBe(100);
      expect(Number(record.total_tokens)).toBe(1800); // Sum of all
    });

    test("should calculate and store cost", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 1000,
        output_tokens: 500,
      });

      const result = await pool.query(
        `SELECT cost FROM api_key_usage_history WHERE key_id = $1`,
        [testKeyId]
      );

      // Sonnet ≤200K: $3 per 1M input, $15 per 1M output
      // Cost = (1000 * 3 / 1_000_000) + (500 * 15 / 1_000_000) = 0.003 + 0.0075 = 0.0105
      expect(Number(result.rows[0].cost)).toBeCloseTo(0.0105, 4);
    });

    test("should still update aggregate api_key_usage table (backward compatibility)", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 1000,
        output_tokens: 500,
      });

      const result = await pool.query(
        `SELECT * FROM api_key_usage WHERE key_id = $1`,
        [testKeyId]
      );

      const usage = result.rows[0];
      expect(Number(usage.input_tokens)).toBe(1000);
      expect(Number(usage.output_tokens)).toBe(500);
      expect(Number(usage.total_tokens)).toBe(1500);
      expect(Number(usage.request_count)).toBe(1);
    });

    test("should handle missing cache tokens (default to 0)", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 1000,
        output_tokens: 500,
        // No cache tokens provided
      });

      const result = await pool.query(
        `SELECT cache_creation_tokens, cache_read_tokens FROM api_key_usage_history
         WHERE key_id = $1`,
        [testKeyId]
      );

      const record = result.rows[0];
      expect(Number(record.cache_creation_tokens)).toBe(0);
      expect(Number(record.cache_read_tokens)).toBe(0);
    });

    test("should record correct model name", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 100,
        output_tokens: 50,
      });

      const result = await pool.query(
        `SELECT model FROM api_key_usage_history WHERE key_id = $1`,
        [testKeyId]
      );

      expect(result.rows[0].model).toBe("claude-3-5-sonnet-20241022");
    });
  });

  describe("Credits Calculation Integration", () => {
    test("Opus request should store 5x credits", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-opus-4-20250514",
        input_tokens: 1000,
        output_tokens: 500,
      });

      const result = await pool.query(
        `SELECT credits_used FROM api_key_usage_history WHERE key_id = $1`,
        [testKeyId]
      );

      // Opus weight = 5.0, total tokens = 1500, credits = 1500 * 5.0 = 7500
      expect(Number(result.rows[0].credits_used)).toBe(7500);
    });

    test("Sonnet request should store 1x credits", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 1000,
        output_tokens: 500,
      });

      const result = await pool.query(
        `SELECT credits_used FROM api_key_usage_history WHERE key_id = $1`,
        [testKeyId]
      );

      // Sonnet weight = 1.0, total tokens = 1500, credits = 1500 * 1.0 = 1500
      expect(Number(result.rows[0].credits_used)).toBe(1500);
    });

    test("Haiku request should store 0.25x credits", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-haiku-20241022",
        input_tokens: 1000,
        output_tokens: 500,
      });

      const result = await pool.query(
        `SELECT credits_used FROM api_key_usage_history WHERE key_id = $1`,
        [testKeyId]
      );

      // Haiku weight = 0.25, total tokens = 1500, credits = 1500 * 0.25 = 375
      expect(Number(result.rows[0].credits_used)).toBe(375);
    });

    test("Unknown model should default to 1x credits (Sonnet weight)", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-unknown-model",
        input_tokens: 1000,
        output_tokens: 500,
      });

      const result = await pool.query(
        `SELECT credits_used FROM api_key_usage_history WHERE key_id = $1`,
        [testKeyId]
      );

      // Default weight = 1.0, total tokens = 1500, credits = 1500 * 1.0 = 1500
      expect(Number(result.rows[0].credits_used)).toBe(1500);
    });
  });

  describe("Timestamp Tracking", () => {
    test("should store timestamp in milliseconds (Date.now())", async () => {
      const beforeMs = Date.now();

      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 100,
        output_tokens: 50,
      });

      const afterMs = Date.now();

      const result = await pool.query(
        `SELECT timestamp FROM api_key_usage_history WHERE key_id = $1`,
        [testKeyId]
      );

      const timestamp = Number(result.rows[0].timestamp);

      // Should be a timestamp in milliseconds (13 digits)
      expect(timestamp.toString().length).toBeGreaterThanOrEqual(13);

      // Should be within test execution window
      expect(timestamp).toBeGreaterThanOrEqual(beforeMs);
      expect(timestamp).toBeLessThanOrEqual(afterMs);
    });

    test("should store current timestamp, not future or past", async () => {
      const now = Date.now();

      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 100,
        output_tokens: 50,
      });

      const result = await pool.query(
        `SELECT timestamp FROM api_key_usage_history WHERE key_id = $1`,
        [testKeyId]
      );

      const timestamp = Number(result.rows[0].timestamp);

      // Should be within 1 second of now (1000ms tolerance)
      expect(Math.abs(timestamp - now)).toBeLessThan(1000);
    });
  });

  describe("Data Integrity", () => {
    test("History record should link to api_key via key_id", async () => {
      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 100,
        output_tokens: 50,
      });

      const result = await pool.query(
        `SELECT h.*, k.id as key_exists
         FROM api_key_usage_history h
         JOIN api_keys k ON h.key_id = k.id
         WHERE h.key_id = $1`,
        [testKeyId]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].key_id).toBe(testKeyId);
      expect(result.rows[0].key_exists).toBe(testKeyId);
    });

    test("Deleting api_key should cascade delete history records", async () => {
      // Create temporary key for cascade test
      const tempUserId = randomUUID();
      const tempKeyId = randomUUID();

      await pool.query(
        `INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)`,
        [tempUserId, `temp-${Date.now()}@example.com`, "hash", Math.floor(Date.now() / 1000)]
      );

      await pool.query(
        `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [tempKeyId, tempUserId, "temp_hash", "sk-temp", Math.floor(Date.now() / 1000)]
      );

      await initializeKeyUsage(tempKeyId);

      // Create history record
      await updateKeyUsage(tempKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 100,
        output_tokens: 50,
      });

      // Verify history exists
      let historyResult = await pool.query(
        `SELECT * FROM api_key_usage_history WHERE key_id = $1`,
        [tempKeyId]
      );
      expect(historyResult.rows.length).toBe(1);

      // Delete the API key
      await pool.query(`DELETE FROM api_keys WHERE id = $1`, [tempKeyId]);

      // Verify history is cascade deleted
      historyResult = await pool.query(
        `SELECT * FROM api_key_usage_history WHERE key_id = $1`,
        [tempKeyId]
      );
      expect(historyResult.rows.length).toBe(0);

      // Cleanup temp user
      await pool.query(`DELETE FROM users WHERE id = $1`, [tempUserId]);
    });
  });

  describe("Multiple Requests Tracking", () => {
    test("should create separate history records for each request", async () => {
      // First request
      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 1000,
        output_tokens: 500,
      });

      // Second request
      await updateKeyUsage(testKeyId, {
        model: "claude-opus-4-20250514",
        input_tokens: 2000,
        output_tokens: 1000,
      });

      // Third request
      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-haiku-20241022",
        input_tokens: 500,
        output_tokens: 250,
      });

      const result = await pool.query(
        `SELECT * FROM api_key_usage_history WHERE key_id = $1 ORDER BY timestamp ASC`,
        [testKeyId]
      );

      expect(result.rows.length).toBe(3);

      // Verify each record
      expect(result.rows[0].model).toBe("claude-3-5-sonnet-20241022");
      expect(Number(result.rows[0].credits_used)).toBe(1500); // 1500 * 1.0

      expect(result.rows[1].model).toBe("claude-opus-4-20250514");
      expect(Number(result.rows[1].credits_used)).toBe(15000); // 3000 * 5.0

      expect(result.rows[2].model).toBe("claude-3-5-haiku-20241022");
      expect(Number(result.rows[2].credits_used)).toBe(188); // ceil(750 * 0.25)
    });

    test("aggregate table should accumulate while history stores individual records", async () => {
      // First request
      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 1000,
        output_tokens: 500,
      });

      // Second request
      await updateKeyUsage(testKeyId, {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 2000,
        output_tokens: 1000,
      });

      // Check history - should have 2 separate records
      const historyResult = await pool.query(
        `SELECT * FROM api_key_usage_history WHERE key_id = $1`,
        [testKeyId]
      );
      expect(historyResult.rows.length).toBe(2);

      // Check aggregate - should have accumulated totals
      const aggregateResult = await pool.query(
        `SELECT * FROM api_key_usage WHERE key_id = $1`,
        [testKeyId]
      );
      const aggregate = aggregateResult.rows[0];

      expect(Number(aggregate.input_tokens)).toBe(3000); // 1000 + 2000
      expect(Number(aggregate.output_tokens)).toBe(1500); // 500 + 1000
      expect(Number(aggregate.total_tokens)).toBe(4500);
      expect(Number(aggregate.request_count)).toBe(2);
    });
  });
});
