import { Pool } from "pg";

// Create PostgreSQL connection pool
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection on startup
pool.on("error", (err) => {
  console.error("Unexpected error on idle database client", err);
});

// Initialize database schema
export async function initializeDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log("[DB] Initializing database schema...");

    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        plan_type VARCHAR(50) DEFAULT 'pro',
        created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      )
    `);

    // Create oauth_tokens table
    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        user_id VARCHAR(255) PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Create api_keys table
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        key_hash VARCHAR(255) UNIQUE NOT NULL,
        key_prefix VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        assigned_to_email VARCHAR(255),
        assigned_to_user_id VARCHAR(255),
        assignment_status VARCHAR(50) DEFAULT 'unassigned',
        invitation_token VARCHAR(255) UNIQUE,
        plan_type VARCHAR(50) DEFAULT 'pro',
        quota_percentage INTEGER DEFAULT 100,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (assigned_to_user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // Create api_key_usage table
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_key_usage (
        key_id VARCHAR(255) PRIMARY KEY,
        input_tokens BIGINT DEFAULT 0,
        output_tokens BIGINT DEFAULT 0,
        cache_creation_tokens BIGINT DEFAULT 0,
        cache_read_tokens BIGINT DEFAULT 0,
        total_tokens BIGINT DEFAULT 0,
        total_cost DECIMAL(10, 5) DEFAULT 0.0,
        last_request_at BIGINT,
        request_count INTEGER DEFAULT 0,
        FOREIGN KEY (key_id) REFERENCES api_keys(id) ON DELETE CASCADE
      )
    `);

    // Create api_key_usage_history table for detailed tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_key_usage_history (
        id SERIAL PRIMARY KEY,
        key_id VARCHAR(255) NOT NULL,
        timestamp BIGINT NOT NULL,
        model VARCHAR(100),
        input_tokens BIGINT DEFAULT 0,
        output_tokens BIGINT DEFAULT 0,
        cache_creation_tokens BIGINT DEFAULT 0,
        cache_read_tokens BIGINT DEFAULT 0,
        total_tokens BIGINT DEFAULT 0,
        cost DECIMAL(10, 5) DEFAULT 0.0,
        credits_used BIGINT DEFAULT 0,
        FOREIGN KEY (key_id) REFERENCES api_keys(id) ON DELETE CASCADE
      )
    `);

    // Create health_check table
    await client.query(`
      CREATE TABLE IF NOT EXISTS health_check (
        id INTEGER PRIMARY KEY,
        last_check BIGINT
      )
    `);

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_assigned_to_user_id ON api_keys(assigned_to_user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_assigned_to_email ON api_keys(assigned_to_email)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_invitation_token ON api_keys(invitation_token)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens(user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_usage_history_key_timestamp
      ON api_key_usage_history(key_id, timestamp DESC)
    `);

    // Migration: Add plan_type column to existing api_keys table if not exists
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'api_keys' AND column_name = 'plan_type'
        ) THEN
          ALTER TABLE api_keys ADD COLUMN plan_type VARCHAR(50) DEFAULT 'pro';
        END IF;
      END $$;
    `);

    // Migration: Add plan_type column to existing users table if not exists
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'plan_type'
        ) THEN
          ALTER TABLE users ADD COLUMN plan_type VARCHAR(50) DEFAULT 'pro';
        END IF;
      END $$;
    `);

    // Migration: Add quota_percentage column to existing api_keys table if not exists
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'api_keys' AND column_name = 'quota_percentage'
        ) THEN
          ALTER TABLE api_keys ADD COLUMN quota_percentage INTEGER DEFAULT 100;
        END IF;
      END $$;
    `);

    console.log("[DB] Database schema initialized successfully");
  } catch (error) {
    console.error("[DB] Failed to initialize database:", error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Clean up old usage history records
 * @param retentionDays Number of days to retain history (default: 30)
 */
export async function cleanupOldUsageHistory(retentionDays: number = 30): Promise<void> {
  const client = await pool.connect();
  try {
    const cutoffTimestamp = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    const result = await client.query(
      `DELETE FROM api_key_usage_history WHERE timestamp < $1`,
      [cutoffTimestamp]
    );

    console.log(`[DB] Cleaned up ${result.rowCount} old usage history records`);
  } catch (error) {
    console.error("[DB] Failed to cleanup old usage history:", error);
    throw error;
  } finally {
    client.release();
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});

export default pool;
