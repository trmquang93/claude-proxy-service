/**
 * Integration tests for quota enforcement in proxy (TDD - Red Phase)
 * These tests MUST fail initially since quota enforcement isn't integrated yet
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import pool from "../src/db";
import { proxyToClaudeAPI } from "../src/proxy";
import { PLAN_LIMITS } from "../src/limits";
import bcrypt from "bcryptjs";

describe("Quota Enforcement - Proxy Integration", () => {
  let testUserId: string;
  let testKeyId: string;
  let testApiKey: string;

  beforeEach(async () => {
    // Create test user
    testUserId = `quota-proxy-user-${Date.now()}`;
    await pool.query(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)",
      [testUserId, `quota-proxy-${Date.now()}@example.com`, "test-hash", Math.floor(Date.now() / 1000)]
    );

    // Create OAuth token for user (expires_at in milliseconds)
    await pool.query(
      `INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [testUserId, "test-access-token", "test-refresh-token", Date.now() + 24 * 60 * 60 * 1000] // +24 hours in milliseconds
    );

    // Create test API key with proper bcrypt hash
    testApiKey = `sk-test-${Date.now()}`;
    testKeyId = `quota-key-${Date.now()}`;
    const keyHash = await bcrypt.hash(testApiKey, 10);

    await pool.query(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, plan_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [testKeyId, testUserId, keyHash, "sk-test", "Quota Enforcement Test Key", "free", Math.floor(Date.now() / 1000)] // Start with free plan for easier limit testing
    );
  });

  afterEach(async () => {
    // Clean up test data
    await pool.query("DELETE FROM api_key_usage_history WHERE key_id = $1", [testKeyId]);
    await pool.query("DELETE FROM api_key_usage WHERE key_id = $1", [testKeyId]);
    await pool.query("DELETE FROM api_keys WHERE id = $1", [testKeyId]);
    await pool.query("DELETE FROM oauth_tokens WHERE user_id = $1", [testUserId]);
    await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
  });

  describe("Quota Check Before Proxying", () => {
    test("should allow request when quota available", async () => {
      // Add minimal usage (10% of free plan limit)
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-haiku-4-20250514", 1000, 1000, 500, Date.now()]
      );

      const request = new Request("http://localhost:3000/v1/messages", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${testApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-20250514",
          max_tokens: 100,
          messages: [{ role: "user", content: "Test" }]
        })
      });

      // Mock Claude API response
      global.fetch = async (url: string, options?: any) => {
        if (url.includes("anthropic.com")) {
          return new Response(
            JSON.stringify({
              id: "msg_123",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Test response" }],
              model: "claude-haiku-4-20250514",
              usage: {
                input_tokens: 10,
                output_tokens: 5
              }
            }),
            { status: 200 }
          );
        }
        throw new Error("Unexpected fetch call");
      };

      const response = await proxyToClaudeAPI(request);

      expect(response.status).toBe(200);

      // Should include quota headers
      expect(response.headers.get("X-RateLimit-Limit")).toBeDefined();
      expect(response.headers.get("X-RateLimit-Remaining")).toBeDefined();
      expect(response.headers.get("X-RateLimit-Reset")).toBeDefined();
    });

    test("should block request with 429 when quota exceeded", async () => {
      // Exceed free plan limit (10,000 credits)
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 5000, 5000, 10000, Date.now()]
      );

      const request = new Request("http://localhost:3000/v1/messages", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${testApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-20250514",
          max_tokens: 100,
          messages: [{ role: "user", content: "Test" }]
        })
      });

      const response = await proxyToClaudeAPI(request);

      expect(response.status).toBe(429);

      const body = await response.json();
      expect(body.error).toBeDefined();
      expect(body.error.type).toBe("rate_limit_error");
      expect(body.error.message).toContain("Quota"); // Capital Q
    });

    test("should include quota headers in successful responses", async () => {
      const request = new Request("http://localhost:3000/v1/messages", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${testApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-20250514",
          max_tokens: 100,
          messages: [{ role: "user", content: "Test" }]
        })
      });

      // Mock Claude API response
      global.fetch = async (url: string, options?: any) => {
        if (url.includes("anthropic.com")) {
          return new Response(
            JSON.stringify({
              id: "msg_123",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Test response" }],
              model: "claude-haiku-4-20250514",
              usage: {
                input_tokens: 10,
                output_tokens: 5
              }
            }),
            { status: 200 }
          );
        }
        throw new Error("Unexpected fetch call");
      };

      const response = await proxyToClaudeAPI(request);

      expect(response.status).toBe(200);

      const limit = response.headers.get("X-RateLimit-Limit");
      const remaining = response.headers.get("X-RateLimit-Remaining");
      const reset = response.headers.get("X-RateLimit-Reset");
      const percentage = response.headers.get("X-Quota-Percentage");

      expect(limit).toBe(PLAN_LIMITS.free.creditsPerWindow.toString());
      expect(remaining).toBeDefined();
      expect(reset).toBeDefined();
      expect(percentage).toBeDefined();
    });

    test("should include retry-after header in blocked responses", async () => {
      // Exceed quota
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 5000, 5000, 10000, Date.now()]
      );

      const request = new Request("http://localhost:3000/v1/messages", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${testApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-20250514",
          max_tokens: 100,
          messages: [{ role: "user", content: "Test" }]
        })
      });

      const response = await proxyToClaudeAPI(request);

      expect(response.status).toBe(429);

      const retryAfter = response.headers.get("Retry-After");
      expect(retryAfter).toBeDefined();
      expect(parseInt(retryAfter!)).toBeGreaterThan(0);
    });

    test("should track usage after successful requests", async () => {
      const request = new Request("http://localhost:3000/v1/messages", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${testApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-20250514",
          max_tokens: 100,
          messages: [{ role: "user", content: "Test" }]
        })
      });

      // Mock Claude API response
      global.fetch = async (url: string, options?: any) => {
        if (url.includes("anthropic.com")) {
          return new Response(
            JSON.stringify({
              id: "msg_123",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Test response" }],
              model: "claude-haiku-4-20250514",
              usage: {
                input_tokens: 100,
                output_tokens: 50
              }
            }),
            { status: 200 }
          );
        }
        throw new Error("Unexpected fetch call");
      };

      const response = await proxyToClaudeAPI(request);
      expect(response.status).toBe(200);

      // Verify usage was tracked
      const usageResult = await pool.query(
        "SELECT * FROM api_key_usage_history WHERE key_id = $1",
        [testKeyId]
      );

      expect(usageResult.rows.length).toBe(1);
      expect(Number(usageResult.rows[0].input_tokens)).toBe(100);
      expect(Number(usageResult.rows[0].output_tokens)).toBe(50);
    });

    test("should respect plan-specific limits (free vs pro)", async () => {
      // Update key to pro plan
      await pool.query(
        "UPDATE api_keys SET plan_type = $1 WHERE id = $2",
        ["pro", testKeyId]
      );

      // Add usage that exceeds free limit but not pro limit
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 10000, 5000, 15000, Date.now()] // 15K credits: exceeds free (10K) but within pro (500K)
      );

      const request = new Request("http://localhost:3000/v1/messages", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${testApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 100,
          messages: [{ role: "user", content: "Test" }]
        })
      });

      // Mock Claude API response
      global.fetch = async (url: string, options?: any) => {
        if (url.includes("anthropic.com")) {
          return new Response(
            JSON.stringify({
              id: "msg_123",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Test response" }],
              model: "claude-sonnet-4-20250514",
              usage: {
                input_tokens: 10,
                output_tokens: 5
              }
            }),
            { status: 200 }
          );
        }
        throw new Error("Unexpected fetch call");
      };

      const response = await proxyToClaudeAPI(request);

      // Should be allowed for pro plan
      expect(response.status).toBe(200);

      const limit = response.headers.get("X-RateLimit-Limit");
      expect(limit).toBe(PLAN_LIMITS.pro.creditsPerWindow.toString());
    });

    test("should handle rolling window correctly (5h vs 24h)", async () => {
      // Update key to max-5x plan (5-hour window)
      await pool.query(
        "UPDATE api_keys SET plan_type = $1 WHERE id = $2",
        ["max-5x", testKeyId]
      );

      const now = new Date();

      // Add usage 6 hours ago (outside 5h window)
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 1000000, 500000, 1500000, now.getTime() - 6 * 60 * 60 * 1000]
      );

      // Add usage 2 hours ago (inside 5h window)
      await pool.query(
        `INSERT INTO api_key_usage_history
         (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testKeyId, "claude-sonnet-4-20250514", 500000, 250000, 750000, now.getTime() - 2 * 60 * 60 * 1000]
      );

      const request = new Request("http://localhost:3000/v1/messages", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${testApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 100,
          messages: [{ role: "user", content: "Test" }]
        })
      });

      // Mock Claude API response
      global.fetch = async (url: string, options?: any) => {
        if (url.includes("anthropic.com")) {
          return new Response(
            JSON.stringify({
              id: "msg_123",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Test response" }],
              model: "claude-sonnet-4-20250514",
              usage: {
                input_tokens: 10,
                output_tokens: 5
              }
            }),
            { status: 200 }
          );
        }
        throw new Error("Unexpected fetch call");
      };

      const response = await proxyToClaudeAPI(request);

      // Should be allowed because 6h-old usage is outside window
      // Only 750K credits count (within 2.5M limit)
      expect(response.status).toBe(200);
    });
  });
});
