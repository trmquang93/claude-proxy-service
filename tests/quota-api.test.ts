/**
 * Tests for Quota API endpoints (TDD - Red Phase)
 * These tests MUST fail initially since the endpoints don't exist yet
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import pool from "../src/db";
import { app } from "../src/index";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-jwt-key";

// Helper function to create JWT token for testing
function createAuthToken(userId: string, email: string): string {
  const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: "7d" });
  return `Bearer ${token}`;
}

describe("Quota API Endpoints", () => {
  let testUserId: string;
  let testKeyId: string;
  let otherUserId: string;
  let otherKeyId: string;
  let authToken: string;
  let otherAuthToken: string;

  beforeEach(async () => {
    const timestamp = Date.now();

    // Create test user 1
    const userResult = await pool.query(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [`quota-api-user-${timestamp}`, `quota-api-test-${timestamp}@example.com`, "test-hash", Math.floor(timestamp / 1000)]
    );
    testUserId = userResult.rows[0].id;

    // Create OAuth connection for test user 1
    await pool.query(
      "INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
      [testUserId, "test-access-token", "test-refresh-token", Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000)]
    );

    // Create test API key for user 1 with pro plan
    const keyResult = await pool.query(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, plan_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [`quota-api-key-${timestamp}`, testUserId, `test-hash-quota-api-${timestamp}`, "sk-test", "Quota API Test Key", "pro", Math.floor(timestamp / 1000)]
    );
    testKeyId = keyResult.rows[0].id;

    // Create test user 2
    const otherUserResult = await pool.query(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [`quota-api-other-user-${timestamp}`, `quota-api-other-${timestamp}@example.com`, "test-hash", Math.floor(timestamp / 1000)]
    );
    otherUserId = otherUserResult.rows[0].id;

    // Create OAuth connection for test user 2
    await pool.query(
      "INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
      [otherUserId, "other-access-token", "other-refresh-token", Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000)]
    );

    // Create API key for user 2
    const otherKeyResult = await pool.query(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, plan_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [`quota-api-other-key-${timestamp}`, otherUserId, `test-hash-other-${timestamp}`, "sk-other", "Other User Key", "pro", Math.floor(timestamp / 1000)]
    );
    otherKeyId = otherKeyResult.rows[0].id;

    // Create valid JWT tokens for testing
    authToken = createAuthToken(testUserId, `quota-api-test-${timestamp}@example.com`);
    otherAuthToken = createAuthToken(otherUserId, `quota-api-other-${timestamp}@example.com`);

    // Add some usage data for testing
    const now = Date.now();
    await pool.query(
      `INSERT INTO api_key_usage_history
       (key_id, model, input_tokens, output_tokens, credits_used, cost, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [testKeyId, "claude-sonnet-4-20250514", 10000, 5000, 15000, 0.06, now - 2 * 60 * 60 * 1000]
    );

    await pool.query(
      `INSERT INTO api_key_usage_history
       (key_id, model, input_tokens, output_tokens, credits_used, cost, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [testKeyId, "claude-opus-4-20250514", 2000, 1000, 15000, 0.13, now - 1 * 60 * 60 * 1000]
    );
  });

  afterEach(async () => {
    // Clean up test data
    await pool.query("DELETE FROM api_key_usage_history WHERE key_id = $1 OR key_id = $2", [testKeyId, otherKeyId]);
    await pool.query("DELETE FROM api_key_usage WHERE key_id = $1 OR key_id = $2", [testKeyId, otherKeyId]);
    await pool.query("DELETE FROM api_keys WHERE id = $1 OR id = $2", [testKeyId, otherKeyId]);
    await pool.query("DELETE FROM oauth_tokens WHERE user_id = $1 OR user_id = $2", [testUserId, otherUserId]);
    await pool.query("DELETE FROM users WHERE id LIKE 'quota-api-user-%' OR id LIKE 'quota-api-other-user-%'");
  });

  describe("GET /api/keys/:id/quota - Individual Key Quota", () => {
    test("should return 401 if not authenticated", async () => {
      const res = await app.request(`/api/keys/${testKeyId}/quota`, {
        method: "GET",
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });

    test("should return 404 if key not found", async () => {
      // Mock authentication by directly calling with context
      const res = await app.request(`/api/keys/non-existent-key-id/quota`, {
        method: "GET",
        headers: {
          authorization: authToken,
        },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Key not found or access denied");
    });

    test("should return 404 if user doesn't own or is not assigned the key", async () => {
      // User 1 trying to access user 2's key
      const res = await app.request(`/api/keys/${otherKeyId}/quota`, {
        method: "GET",
        headers: {
          authorization: authToken,
        },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Key not found or access denied");
    });

    test("should return quota status for owned key", async () => {
      const res = await app.request(`/api/keys/${testKeyId}/quota`, {
        method: "GET",
        headers: {
          authorization: authToken,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      // Validate response structure
      expect(body).toHaveProperty("quota");
      expect(body.quota).toHaveProperty("plan");
      expect(body.quota).toHaveProperty("usage");
      expect(body.quota).toHaveProperty("percentages");
      expect(body.quota).toHaveProperty("limits");
      expect(body.quota).toHaveProperty("reset");
      expect(body.quota).toHaveProperty("modelBreakdown");

      // Validate plan
      expect(body.quota.plan).toBe("pro");

      // Validate usage (numbers)
      expect(typeof body.quota.usage.credits).toBe("number");
      expect(typeof body.quota.usage.requests).toBe("number");
      expect(typeof body.quota.usage.cost).toBe("number");
      expect(body.quota.usage.credits).toBe(30000); // 15000 + 15000

      // Validate percentages (rounded to integers)
      expect(typeof body.quota.percentages.credits).toBe("number");
      expect(typeof body.quota.percentages.requests).toBe("number");
      expect(typeof body.quota.percentages.overall).toBe("number");
      expect(typeof body.quota.percentages.isOverLimit).toBe("boolean");
      expect(body.quota.percentages.credits).toBe(6); // 30000 / 500000 * 100 = 6%

      // Validate limits
      expect(body.quota.limits.creditsPerWindow).toBe(500000); // Pro plan
      expect(body.quota.limits.windowHours).toBe(5);
      expect(body.quota.limits.maxRequestsPerMinute).toBe(50);

      // Validate reset information
      expect(body.quota.reset).toHaveProperty("nextResetAt");
      expect(body.quota.reset).toHaveProperty("timeUntilResetMs");
      expect(body.quota.reset).toHaveProperty("timeUntilResetHuman");

      // Validate timestamp is ISO 8601 format
      expect(body.quota.reset.nextResetAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(typeof body.quota.reset.timeUntilResetMs).toBe("number");
      expect(typeof body.quota.reset.timeUntilResetHuman).toBe("string");

      // Validate model breakdown
      expect(Array.isArray(body.quota.modelBreakdown)).toBe(true);
      expect(body.quota.modelBreakdown.length).toBeGreaterThan(0);

      for (const breakdown of body.quota.modelBreakdown) {
        expect(breakdown).toHaveProperty("model");
        expect(breakdown).toHaveProperty("requests");
        expect(breakdown).toHaveProperty("credits");
        expect(breakdown).toHaveProperty("percentage");
        expect(typeof breakdown.percentage).toBe("number");
      }
    });

    test("should return quota status for assigned key", async () => {
      // Assign testKey to otherUser
      await pool.query(
        `UPDATE api_keys
         SET assigned_to_user_id = $1, assignment_status = 'accepted'
         WHERE id = $2`,
        [otherUserId, testKeyId]
      );

      // Other user should be able to access quota
      const res = await app.request(`/api/keys/${testKeyId}/quota`, {
        method: "GET",
        headers: {
          authorization: otherAuthToken,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("quota");
      expect(body.quota.plan).toBe("pro");
    });

    test("should handle key with no usage (0 credits)", async () => {
      // Create new key with no usage
      const timestamp = Date.now();
      const newKeyResult = await pool.query(
        "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, plan_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
        [`quota-api-new-key-${timestamp}`, testUserId, `new-hash-${timestamp}`, "sk-new", "New Key", "pro", Math.floor(timestamp / 1000)]
      );
      const newKeyId = newKeyResult.rows[0].id;

      const res = await app.request(`/api/keys/${newKeyId}/quota`, {
        method: "GET",
        headers: {
          authorization: authToken,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.quota.usage.credits).toBe(0);
      expect(body.quota.usage.requests).toBe(0);
      expect(body.quota.percentages.credits).toBe(0);
      expect(body.quota.percentages.isOverLimit).toBe(false);

      // Clean up
      await pool.query("DELETE FROM api_keys WHERE id = $1", [newKeyId]);
    });

    test("should correctly handle different plan types", async () => {
      // Update user's plan to max-5x
      await pool.query(
        "UPDATE users SET plan_type = $1 WHERE id = $2",
        ["max-5x", testUserId]
      );

      // Create a key (it will use user's plan)
      const timestamp = Date.now();
      const maxKeyResult = await pool.query(
        "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [`quota-api-max-key-${timestamp}`, testUserId, `max-hash-${timestamp}`, "sk-max", "Max Key", Math.floor(timestamp / 1000)]
      );
      const maxKeyId = maxKeyResult.rows[0].id;

      const res = await app.request(`/api/keys/${maxKeyId}/quota`, {
        method: "GET",
        headers: {
          authorization: authToken,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.quota.plan).toBe("max-5x");
      expect(body.quota.limits.creditsPerWindow).toBe(2500000); // Max 5x limit
      expect(body.quota.limits.windowHours).toBe(5);
      expect(body.quota.limits.maxRequestsPerMinute).toBe(100);

      // Clean up
      await pool.query("DELETE FROM api_keys WHERE id = $1", [maxKeyId]);
      await pool.query("UPDATE users SET plan_type = $1 WHERE id = $2", ["pro", testUserId]); // Reset plan
    });
  });

  describe("GET /api/quota/overview - Aggregate Quota Overview", () => {
    test("should return 401 if not authenticated", async () => {
      const res = await app.request("/api/quota/overview", {
        method: "GET",
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });

    test("should return empty stats if user has no keys", async () => {
      // Create user with no keys
      const timestamp = Date.now();
      const noKeysUserResult = await pool.query(
        "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
        [`quota-api-nokeys-user-${timestamp}`, `nokeys-${timestamp}@example.com`, "test-hash", Math.floor(timestamp / 1000)]
      );
      const noKeysUserId = noKeysUserResult.rows[0].id;
      const noKeysToken = createAuthToken(noKeysUserId, `nokeys-${timestamp}@example.com`);

      const res = await app.request("/api/quota/overview", {
        method: "GET",
        headers: {
          authorization: noKeysToken,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("overview");
      expect(body.overview.totalKeys).toBe(0);
      expect(body.overview.aggregateUsage.credits).toBe(0);
      expect(body.overview.aggregateUsage.requests).toBe(0);
      expect(body.overview.aggregateUsage.cost).toBe(0);
      expect(body.overview.keys).toEqual([]);

      // Clean up
      await pool.query("DELETE FROM users WHERE id = $1", [noKeysUserId]);
    });

    test("should return aggregate quota for all owned keys", async () => {
      // Create second key for testUser
      const timestamp = Date.now();
      const secondKeyResult = await pool.query(
        "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, plan_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
        [`quota-api-second-key-${timestamp}`, testUserId, `second-hash-${timestamp}`, "sk-second", "Second Key", "pro", Math.floor(timestamp / 1000)]
      );
      const secondKeyId = secondKeyResult.rows[0].id;

      // Add usage to second key
      const now = Date.now();
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, cost, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [secondKeyId, "claude-sonnet-4-20250514", 5000, 2500, 7500, 0.03, now - 1 * 60 * 60 * 1000]
      );

      const res = await app.request("/api/quota/overview", {
        method: "GET",
        headers: {
          authorization: authToken,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      // Validate response structure
      expect(body).toHaveProperty("overview");
      expect(body.overview).toHaveProperty("totalKeys");
      expect(body.overview).toHaveProperty("aggregateUsage");
      expect(body.overview).toHaveProperty("keys");

      // Should have 2 owned keys
      expect(body.overview.totalKeys).toBe(2);

      // Validate aggregate usage
      expect(typeof body.overview.aggregateUsage.credits).toBe("number");
      expect(typeof body.overview.aggregateUsage.requests).toBe("number");
      expect(typeof body.overview.aggregateUsage.cost).toBe("number");

      // Total credits = 30000 (first key) + 7500 (second key) = 37500
      expect(body.overview.aggregateUsage.credits).toBe(37500);
      expect(body.overview.aggregateUsage.requests).toBe(3); // 2 + 1

      // Validate keys array
      expect(Array.isArray(body.overview.keys)).toBe(true);
      expect(body.overview.keys.length).toBe(2);

      for (const key of body.overview.keys) {
        expect(key).toHaveProperty("keyId");
        expect(key).toHaveProperty("keyPrefix");
        expect(key).toHaveProperty("name");
        expect(key).toHaveProperty("plan");
        expect(key).toHaveProperty("credits");
        expect(key).toHaveProperty("requests");
        expect(key).toHaveProperty("percentage");
        expect(key).toHaveProperty("isOverLimit");

        expect(typeof key.credits).toBe("number");
        expect(typeof key.requests).toBe("number");
        expect(typeof key.percentage).toBe("number");
        expect(typeof key.isOverLimit).toBe("boolean");
      }

      // Clean up
      await pool.query("DELETE FROM api_key_usage_history WHERE key_id = $1", [secondKeyId]);
      await pool.query("DELETE FROM api_keys WHERE id = $1", [secondKeyId]);
    });

    test("should include breakdown by key with correct calculations", async () => {
      const res = await app.request("/api/quota/overview", {
        method: "GET",
        headers: {
          authorization: authToken,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      const keys = body.overview.keys;
      expect(keys.length).toBeGreaterThan(0);

      // Find the test key
      const testKey = keys.find((k: any) => k.keyId === testKeyId);
      expect(testKey).toBeDefined();
      expect(testKey.credits).toBe(30000);
      expect(testKey.percentage).toBe(6); // 30000 / 500000 * 100 = 6%
      expect(testKey.isOverLimit).toBe(false);
    });

    test("should show correct plan usage across multiple keys", async () => {
      // Update user's plan to max-20x (all keys will use this plan)
      await pool.query(
        "UPDATE users SET plan_type = $1 WHERE id = $2",
        ["max-20x", testUserId]
      );

      // Create a second key (will use user's max-20x plan)
      const timestamp = Date.now();
      const maxKeyResult = await pool.query(
        "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [`quota-api-max20-key-${timestamp}`, testUserId, `max20-hash-${timestamp}`, "sk-max20", "Max 20x Key", Math.floor(timestamp / 1000)]
      );
      const maxKeyId = maxKeyResult.rows[0].id;

      // Add high usage to trigger higher percentage
      const now = Date.now();
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, cost, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [maxKeyId, "claude-opus-4-20250514", 500000, 250000, 3750000, 1.5, now - 1 * 60 * 60 * 1000]
      );

      const res = await app.request("/api/quota/overview", {
        method: "GET",
        headers: {
          authorization: authToken,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      // Should have 2 keys now (testKey + maxKey)
      expect(body.overview.totalKeys).toBe(2);

      // Find the max key
      const maxKey = body.overview.keys.find((k: any) => k.keyId === maxKeyId);
      expect(maxKey).toBeDefined();
      expect(maxKey.plan).toBe("max-20x");
      expect(maxKey.percentage).toBe(38); // 3750000 / 10000000 * 100 = 37.5% -> rounded to 38%

      // Clean up
      await pool.query("DELETE FROM api_key_usage_history WHERE key_id = $1", [maxKeyId]);
      await pool.query("DELETE FROM api_keys WHERE id = $1", [maxKeyId]);
      await pool.query("UPDATE users SET plan_type = $1 WHERE id = $2", ["pro", testUserId]); // Reset plan
    });

    test("should not include assigned keys (only owned keys)", async () => {
      // User 1 assigns their key to User 2
      await pool.query(
        `UPDATE api_keys
         SET assigned_to_user_id = $1, assigned_to_email = 'quota-api-other@example.com', assignment_status = 'accepted'
         WHERE id = $2`,
        [otherUserId, testKeyId]
      );

      // User 2's overview should NOT include the assigned key (only owned keys)
      const res = await app.request("/api/quota/overview", {
        method: "GET",
        headers: {
          authorization: otherAuthToken,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      // User 2 has 1 owned key (otherKeyId), assigned key should not be in overview
      expect(body.overview.totalKeys).toBe(1);
      expect(body.overview.keys[0].keyId).toBe(otherKeyId);
    });
  });

  describe("Response Format Validation", () => {
    test("all timestamps should be in ISO 8601 format", async () => {
      const res = await app.request(`/api/keys/${testKeyId}/quota`, {
        method: "GET",
        headers: {
          authorization: authToken,
        },
      });

      const body = await res.json();
      const timestamp = body.quota.reset.nextResetAt;

      // ISO 8601 format: YYYY-MM-DDTHH:mm:ss.sssZ
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // Should be parseable as Date
      const date = new Date(timestamp);
      expect(date.getTime()).toBeGreaterThan(0);
    });

    test("all percentages should be integers (rounded)", async () => {
      const res = await app.request(`/api/keys/${testKeyId}/quota`, {
        method: "GET",
        headers: {
          authorization: authToken,
        },
      });

      const body = await res.json();

      // Percentages should be integers
      expect(Number.isInteger(body.quota.percentages.credits)).toBe(true);
      expect(Number.isInteger(body.quota.percentages.requests)).toBe(true);
      expect(Number.isInteger(body.quota.percentages.overall)).toBe(true);

      // Model breakdown percentages should be numbers (can be decimals)
      for (const breakdown of body.quota.modelBreakdown) {
        expect(typeof breakdown.percentage).toBe("number");
      }
    });

    test("credits and tokens should be integers", async () => {
      const res = await app.request(`/api/keys/${testKeyId}/quota`, {
        method: "GET",
        headers: {
          authorization: authToken,
        },
      });

      const body = await res.json();

      expect(Number.isInteger(body.quota.usage.credits)).toBe(true);
      expect(Number.isInteger(body.quota.usage.requests)).toBe(true);
      expect(Number.isInteger(body.quota.limits.creditsPerWindow)).toBe(true);
      expect(Number.isInteger(body.quota.limits.windowHours)).toBe(true);
      expect(Number.isInteger(body.quota.limits.maxRequestsPerMinute)).toBe(true);
    });

    test("cost should be a number with decimal precision", async () => {
      const res = await app.request(`/api/keys/${testKeyId}/quota`, {
        method: "GET",
        headers: {
          authorization: authToken,
        },
      });

      const body = await res.json();

      expect(typeof body.quota.usage.cost).toBe("number");
      // Cost should be a valid number (can be decimal)
      expect(body.quota.usage.cost).toBeGreaterThanOrEqual(0);
    });
  });
});
