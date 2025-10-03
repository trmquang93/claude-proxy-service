import pool from "./src/db";

async function checkDatabase() {
  try {
    console.log("=== Checking API Keys ===");
    const keysResult = await pool.query(`
      SELECT id, name, plan_type, key_prefix
      FROM api_keys
      ORDER BY created_at DESC
      LIMIT 5
    `);
    console.log("API Keys:", keysResult.rows);

    console.log("\n=== Checking Usage History ===");
    const usageResult = await pool.query(`
      SELECT
        COUNT(*) as request_count,
        COALESCE(SUM(credits_used), 0) as total_credits
      FROM api_key_usage_history
    `);
    console.log("Usage:", usageResult.rows[0]);

    console.log("\n=== Checking Recent Requests ===");
    const recentResult = await pool.query(`
      SELECT
        h.timestamp,
        h.model,
        h.credits_used,
        k.name as key_name
      FROM api_key_usage_history h
      JOIN api_keys k ON h.key_id = k.id
      ORDER BY h.timestamp DESC
      LIMIT 10
    `);
    console.log("Recent requests:", recentResult.rows);

    await pool.end();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

checkDatabase();
