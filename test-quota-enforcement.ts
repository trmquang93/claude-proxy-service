/**
 * Manual test script to demonstrate quota enforcement
 * Run with: bun run test-quota-enforcement.ts
 */

import pool from "./src/db";
import { proxyToClaudeAPI } from "./src/proxy";
import bcrypt from "bcryptjs";

async function testQuotaEnforcement() {
  console.log("\n🧪 Testing Quota Enforcement\n");
  console.log("=".repeat(50));

  // 1. Setup test data
  const userId = `test-manual-${Date.now()}`;
  const keyId = `key-manual-${Date.now()}`;
  const rawApiKey = `sk-test-manual-${Date.now()}`;
  const keyHash = await bcrypt.hash(rawApiKey, 10);

  console.log("\n1️⃣  Setting up test user and API key...");

  // Create user
  await pool.query(
    "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)",
    [userId, `test-${Date.now()}@example.com`, "hash", Math.floor(Date.now() / 1000)]
  );

  // Create OAuth token
  await pool.query(
    "INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at) VALUES ($1, $2, $3, $4)",
    [userId, "test-token", "test-refresh", Date.now() + 24 * 60 * 60 * 1000]
  );

  // Create API key with FREE plan (10,000 credits limit)
  await pool.query(
    "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, plan_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [keyId, userId, keyHash, "sk-test", "Manual Test Key", "free", Math.floor(Date.now() / 1000)]
  );

  console.log("✅ Test user and API key created");
  console.log(`   Plan: FREE (10,000 credits/24h)`);
  console.log(`   API Key: ${rawApiKey}`);

  // 2. Test under quota (should succeed)
  console.log("\n2️⃣  Testing request UNDER quota (0% used)...");

  // Mock Claude API
  global.fetch = async (url: string) => {
    if (url.includes("anthropic.com")) {
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Test response" }],
          usage: { input_tokens: 10, output_tokens: 5 }
        }),
        { status: 200 }
      );
    }
    throw new Error("Unexpected fetch");
  };

  const request1 = new Request("http://localhost:3000/v1/messages", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${rawApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-20250514",
      max_tokens: 100,
      messages: [{ role: "user", content: "Test" }]
    })
  });

  const response1 = await proxyToClaudeAPI(request1);
  console.log(`   Status: ${response1.status}`);
  console.log(`   X-RateLimit-Limit: ${response1.headers.get("X-RateLimit-Limit")}`);
  console.log(`   X-RateLimit-Remaining: ${response1.headers.get("X-RateLimit-Remaining")}`);
  console.log(`   X-Quota-Percentage: ${response1.headers.get("X-Quota-Percentage")}%`);

  // 3. Simulate quota exceeded
  console.log("\n3️⃣  Simulating QUOTA EXCEEDED (adding 10,000 credits usage)...");

  await pool.query(
    `INSERT INTO api_key_usage_history (key_id, model, input_tokens, output_tokens, credits_used, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [keyId, "claude-sonnet-4-20250514", 5000, 5000, 10000, Date.now()]
  );

  console.log("✅ Usage history updated: 10,000 credits (100% of free plan)");

  // 4. Test over quota (should block with 429)
  console.log("\n4️⃣  Testing request OVER quota (100% used)...");

  const request2 = new Request("http://localhost:3000/v1/messages", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${rawApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-20250514",
      max_tokens: 100,
      messages: [{ role: "user", content: "Test" }]
    })
  });

  const response2 = await proxyToClaudeAPI(request2);
  const body = await response2.json();

  console.log(`   Status: ${response2.status} ⛔`);
  console.log(`   Retry-After: ${response2.headers.get("Retry-After")} seconds`);
  console.log(`   X-RateLimit-Remaining: ${response2.headers.get("X-RateLimit-Remaining")}`);

  console.log("\n📝 Error Response:");
  console.log(JSON.stringify(body, null, 2));

  // 5. Cleanup
  console.log("\n5️⃣  Cleaning up test data...");
  await pool.query("DELETE FROM api_key_usage_history WHERE key_id = $1", [keyId]);
  await pool.query("DELETE FROM api_key_usage WHERE key_id = $1", [keyId]);
  await pool.query("DELETE FROM api_keys WHERE id = $1", [keyId]);
  await pool.query("DELETE FROM oauth_tokens WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);

  console.log("✅ Cleanup complete");
  console.log("\n" + "=".repeat(50));
  console.log("✅ Quota enforcement test complete!\n");

  process.exit(0);
}

testQuotaEnforcement().catch(console.error);
