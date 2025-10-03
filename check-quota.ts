import pool from "./src/db";
import { getRollingWindowUsage } from "./src/quota";
import { PLAN_LIMITS } from "./src/limits";

async function checkQuota() {
  try {
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

    console.log(`\n=== Quota Status for Key: ${key.id} ===`);
    console.log(`Plan: ${key.plan_type}`);

    const planLimits = PLAN_LIMITS[key.plan_type];
    console.log(`\nPlan Limits:`);
    console.log(`  - Credits per window: ${planLimits.creditsPerWindow.toLocaleString()}`);
    console.log(`  - Window hours: ${planLimits.windowHours}h`);

    const usage = await getRollingWindowUsage(key.id, planLimits.windowHours);

    console.log(`\nCurrent Usage:`);
    console.log(`  - Credits used: ${usage.currentCredits.toLocaleString()}`);
    console.log(`  - Request count: ${usage.requestCount}`);
    console.log(`  - Percentage: ${((usage.currentCredits / planLimits.creditsPerWindow) * 100).toFixed(2)}%`);

    if (usage.timeUntilResetMs > 0) {
      const hours = Math.floor(usage.timeUntilResetMs / (1000 * 60 * 60));
      const minutes = Math.floor((usage.timeUntilResetMs % (1000 * 60 * 60)) / (1000 * 60));
      console.log(`  - Time until reset: ${hours}h ${minutes}m`);
      console.log(`  - Reset at: ${new Date(Date.now() + usage.timeUntilResetMs).toLocaleString()}`);
    }

    const exceeded = usage.currentCredits > planLimits.creditsPerWindow;
    console.log(`\n${exceeded ? '🚫 QUOTA EXCEEDED' : '✅ QUOTA OK'}`);

    await pool.end();
  } catch (error) {
    console.error("Error:", error);
    await pool.end();
    process.exit(1);
  }
}

checkQuota();
