import pool from "./src/db";

async function upgradePlan() {
  try {
    // Get current key
    const keysResult = await pool.query(`
      SELECT id, name, plan_type
      FROM api_keys
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const key = keysResult.rows[0];
    if (!key) {
      console.log("No API keys found");
      return;
    }

    console.log(`Current plan: ${key.plan_type}`);
    console.log(`Key ID: ${key.id}`);

    // Upgrade to max-20x (10M credits per 5 hours)
    const newPlan = 'max-20x';

    await pool.query(
      'UPDATE api_keys SET plan_type = $1 WHERE id = $2',
      [newPlan, key.id]
    );

    console.log(`\n✅ Plan upgraded to: ${newPlan}`);
    console.log(`New limits:`);
    console.log(`  - 10,000,000 credits per 5 hours`);
    console.log(`  - Rolling window (not fixed periods)`);

    await pool.end();
  } catch (error) {
    console.error("Error:", error);
    await pool.end();
    process.exit(1);
  }
}

upgradePlan();
