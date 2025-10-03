import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import pool from "../src/db";
import { updateKeyUsage, initializeKeyUsage } from "../src/usage";
import { randomUUID } from "crypto";

/**
 * Integration test to verify usage history tracking works end-to-end
 * This simulates the actual proxy flow:
 * 1. API request comes in
 * 2. Proxy forwards to Claude API
 * 3. Claude response includes usage data
 * 4. updateKeyUsage() is called with usage data
 * 5. Verify both history and aggregate tables are updated correctly
 */
describe("Integration: Usage History Tracking with Proxy Flow", () => {
  let testUserId: string;
  let testKeyId: string;

  beforeAll(async () => {
    testUserId = randomUUID();
    testKeyId = randomUUID();

    // Create test user
    await pool.query(
      `INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)`,
      [testUserId, `integration-test-${Date.now()}@example.com`, "hash", Math.floor(Date.now() / 1000)]
    );

    // Create test API key
    await pool.query(
      `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [testKeyId, testUserId, `integration_hash_${testKeyId}`, "sk-int", Math.floor(Date.now() / 1000)]
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

  test("Simulated proxy request should create history record with correct credits", async () => {
    // Simulate Claude API response with usage data (Opus model)
    const claudeUsageResponse = {
      model: "claude-opus-4-20250514",
      input_tokens: 2000,
      output_tokens: 1000,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 200,
    };

    // This is what the proxy does after receiving Claude response
    await updateKeyUsage(testKeyId, claudeUsageResponse);

    // Verify history record was created
    const historyResult = await pool.query(
      `SELECT * FROM api_key_usage_history WHERE key_id = $1`,
      [testKeyId]
    );

    expect(historyResult.rows.length).toBe(1);
    const history = historyResult.rows[0];

    // Verify all data is correct
    expect(history.model).toBe("claude-opus-4-20250514");
    expect(Number(history.input_tokens)).toBe(2000);
    expect(Number(history.output_tokens)).toBe(1000);
    expect(Number(history.cache_creation_tokens)).toBe(500);
    expect(Number(history.cache_read_tokens)).toBe(200);

    // Total tokens = 2000 + 1000 + 500 + 200 = 3700
    expect(Number(history.total_tokens)).toBe(3700);

    // Opus weight = 5.0, credits = 3700 * 5.0 = 18,500
    expect(Number(history.credits_used)).toBe(18500);

    // Verify timestamp is recent (within last 5 seconds)
    const now = Date.now();
    const timestamp = Number(history.timestamp);
    expect(timestamp).toBeGreaterThan(now - 5000);
    expect(timestamp).toBeLessThanOrEqual(now);

    // Verify aggregate table was also updated
    const aggregateResult = await pool.query(
      `SELECT * FROM api_key_usage WHERE key_id = $1`,
      [testKeyId]
    );

    const aggregate = aggregateResult.rows[0];
    expect(Number(aggregate.input_tokens)).toBe(2000);
    expect(Number(aggregate.output_tokens)).toBe(1000);
    expect(Number(aggregate.cache_creation_tokens)).toBe(500);
    expect(Number(aggregate.cache_read_tokens)).toBe(200);
    expect(Number(aggregate.total_tokens)).toBe(3700);
    expect(Number(aggregate.request_count)).toBe(1);
  });

  test("Multiple proxy requests should create separate history records", async () => {
    // Clear history
    await pool.query(`DELETE FROM api_key_usage_history WHERE key_id = $1`, [testKeyId]);
    await pool.query(
      `UPDATE api_key_usage SET
        input_tokens = 0, output_tokens = 0,
        cache_creation_tokens = 0, cache_read_tokens = 0,
        total_tokens = 0, total_cost = 0, request_count = 0
       WHERE key_id = $1`,
      [testKeyId]
    );

    // Simulate 3 different requests with different models
    const requests = [
      {
        model: "claude-3-5-sonnet-20241022",
        input_tokens: 1000,
        output_tokens: 500,
      },
      {
        model: "claude-opus-4-20250514",
        input_tokens: 500,
        output_tokens: 250,
      },
      {
        model: "claude-3-5-haiku-20241022",
        input_tokens: 2000,
        output_tokens: 1000,
      },
    ];

    // Process each request
    for (const request of requests) {
      await updateKeyUsage(testKeyId, request);
    }

    // Verify 3 separate history records created
    const historyResult = await pool.query(
      `SELECT * FROM api_key_usage_history WHERE key_id = $1 ORDER BY timestamp ASC`,
      [testKeyId]
    );

    expect(historyResult.rows.length).toBe(3);

    // Verify credits for each request
    const [sonnet, opus, haiku] = historyResult.rows;

    // Sonnet: 1500 tokens * 1.0 = 1500 credits
    expect(Number(sonnet.credits_used)).toBe(1500);

    // Opus: 750 tokens * 5.0 = 3750 credits
    expect(Number(opus.credits_used)).toBe(3750);

    // Haiku: 3000 tokens * 0.25 = 750 credits
    expect(Number(haiku.credits_used)).toBe(750);

    // Verify aggregate accumulated correctly
    const aggregateResult = await pool.query(
      `SELECT * FROM api_key_usage WHERE key_id = $1`,
      [testKeyId]
    );

    const aggregate = aggregateResult.rows[0];
    expect(Number(aggregate.input_tokens)).toBe(3500); // 1000 + 500 + 2000
    expect(Number(aggregate.output_tokens)).toBe(1750); // 500 + 250 + 1000
    expect(Number(aggregate.total_tokens)).toBe(5250); // 1500 + 750 + 3000
    expect(Number(aggregate.request_count)).toBe(3);
  });

  test("History tracking should work with edge cases", async () => {
    // Clear history
    await pool.query(`DELETE FROM api_key_usage_history WHERE key_id = $1`, [testKeyId]);

    // Test with missing cache tokens (should default to 0)
    await updateKeyUsage(testKeyId, {
      model: "claude-3-5-sonnet-20241022",
      input_tokens: 100,
      output_tokens: 50,
      // No cache tokens
    });

    const result = await pool.query(
      `SELECT * FROM api_key_usage_history WHERE key_id = $1`,
      [testKeyId]
    );

    expect(result.rows.length).toBe(1);
    expect(Number(result.rows[0].cache_creation_tokens)).toBe(0);
    expect(Number(result.rows[0].cache_read_tokens)).toBe(0);
    expect(Number(result.rows[0].total_tokens)).toBe(150);
    expect(Number(result.rows[0].credits_used)).toBe(150); // 150 * 1.0 (Sonnet)
  });
});
