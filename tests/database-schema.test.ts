import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { pool, initializeDatabase, cleanupOldUsageHistory } from "../src/db";
import type { PlanType } from "../src/limits";

describe("Database Schema Updates", () => {
  beforeAll(async () => {
    // Initialize database schema before running tests
    await initializeDatabase();

    // Clean up any existing test data
    const client = await pool.connect();
    try {
      await client.query("DELETE FROM api_key_usage_history");
      await client.query("DELETE FROM api_key_usage");
      await client.query("DELETE FROM api_keys");
      await client.query("DELETE FROM oauth_tokens");
      await client.query("DELETE FROM users");
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    // Clean up test data after tests
    const client = await pool.connect();
    try {
      await client.query("DELETE FROM api_key_usage_history");
      await client.query("DELETE FROM api_key_usage");
      await client.query("DELETE FROM api_keys");
      await client.query("DELETE FROM oauth_tokens");
      await client.query("DELETE FROM users");
    } finally {
      client.release();
    }
  });

  describe("api_key_usage_history table", () => {
    test("should exist after initialization", async () => {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_name = 'api_key_usage_history'
          )
        `);
        expect(result.rows[0].exists).toBe(true);
      } finally {
        client.release();
      }
    });

    test("should have all required columns with correct types", async () => {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_name = 'api_key_usage_history'
          ORDER BY ordinal_position
        `);

        const columns = result.rows.reduce((acc, row) => {
          acc[row.column_name] = {
            data_type: row.data_type,
            is_nullable: row.is_nullable,
          };
          return acc;
        }, {} as Record<string, { data_type: string; is_nullable: string }>);

        // Check all required columns exist
        expect(columns.id).toBeDefined();
        expect(columns.key_id).toBeDefined();
        expect(columns.timestamp).toBeDefined();
        expect(columns.model).toBeDefined();
        expect(columns.input_tokens).toBeDefined();
        expect(columns.output_tokens).toBeDefined();
        expect(columns.cache_creation_tokens).toBeDefined();
        expect(columns.cache_read_tokens).toBeDefined();
        expect(columns.total_tokens).toBeDefined();
        expect(columns.cost).toBeDefined();
        expect(columns.credits_used).toBeDefined();

        // Check types
        expect(columns.id.data_type).toBe("integer");
        expect(columns.key_id.data_type).toBe("character varying");
        expect(columns.timestamp.data_type).toBe("bigint");
        expect(columns.model.data_type).toBe("character varying");
        expect(columns.input_tokens.data_type).toBe("bigint");
        expect(columns.output_tokens.data_type).toBe("bigint");
        expect(columns.cache_creation_tokens.data_type).toBe("bigint");
        expect(columns.cache_read_tokens.data_type).toBe("bigint");
        expect(columns.total_tokens.data_type).toBe("bigint");
        expect(columns.cost.data_type).toBe("numeric");
        expect(columns.credits_used.data_type).toBe("bigint");

        // Check nullability
        expect(columns.key_id.is_nullable).toBe("NO");
        expect(columns.timestamp.is_nullable).toBe("NO");
      } finally {
        client.release();
      }
    });

    test("should have foreign key constraint to api_keys with CASCADE delete", async () => {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT
            tc.constraint_name,
            tc.table_name,
            kcu.column_name,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name,
            rc.delete_rule
          FROM information_schema.table_constraints AS tc
          JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
          JOIN information_schema.referential_constraints AS rc
            ON rc.constraint_name = tc.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_name = 'api_key_usage_history'
            AND kcu.column_name = 'key_id'
        `);

        expect(result.rows.length).toBe(1);
        const fk = result.rows[0];
        expect(fk.foreign_table_name).toBe("api_keys");
        expect(fk.foreign_column_name).toBe("id");
        expect(fk.delete_rule).toBe("CASCADE");
      } finally {
        client.release();
      }
    });

    test("should have index on (key_id, timestamp DESC)", async () => {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT
            i.relname as index_name,
            a.attname as column_name,
            am.amname as index_type
          FROM pg_class t
          JOIN pg_index ix ON t.oid = ix.indrelid
          JOIN pg_class i ON i.oid = ix.indexrelid
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
          JOIN pg_am am ON i.relam = am.oid
          WHERE t.relname = 'api_key_usage_history'
            AND i.relname = 'idx_usage_history_key_timestamp'
          ORDER BY a.attnum
        `);

        expect(result.rows.length).toBeGreaterThan(0);
        const indexColumns = result.rows.map((r) => r.column_name);
        expect(indexColumns).toContain("key_id");
        expect(indexColumns).toContain("timestamp");
      } finally {
        client.release();
      }
    });

    test("should allow inserting and querying records", async () => {
      const client = await pool.connect();
      try {
        // Create test user, api key first
        await client.query(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES ('test-user-1', 'test@example.com', 'hash123', ${Date.now()})
        `);

        await client.query(`
          INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
          VALUES ('test-key-1', 'test-user-1', 'hash123', 'sk-test', ${Date.now()})
        `);

        // Insert usage history record
        const timestamp = Date.now();
        await client.query(`
          INSERT INTO api_key_usage_history (
            key_id, timestamp, model, input_tokens, output_tokens,
            cache_creation_tokens, cache_read_tokens, total_tokens, cost, credits_used
          ) VALUES (
            'test-key-1', ${timestamp}, 'claude-sonnet-4', 1000, 500,
            0, 0, 1500, 0.015, 1500
          )
        `);

        // Query it back
        const result = await client.query(`
          SELECT * FROM api_key_usage_history WHERE key_id = 'test-key-1'
        `);

        expect(result.rows.length).toBe(1);
        expect(result.rows[0].model).toBe("claude-sonnet-4");
        expect(parseInt(result.rows[0].input_tokens)).toBe(1000);
        expect(parseInt(result.rows[0].output_tokens)).toBe(500);
        expect(parseInt(result.rows[0].total_tokens)).toBe(1500);
        expect(parseFloat(result.rows[0].cost)).toBe(0.015);
        expect(parseInt(result.rows[0].credits_used)).toBe(1500);
      } finally {
        client.release();
      }
    });

    test("should cascade delete when api_key is deleted", async () => {
      const client = await pool.connect();
      try {
        // Create test user and api key
        await client.query(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES ('test-user-2', 'test2@example.com', 'hash123', ${Date.now()})
          ON CONFLICT (id) DO NOTHING
        `);

        await client.query(`
          INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
          VALUES ('test-key-2', 'test-user-2', 'hash456', 'sk-test2', ${Date.now()})
        `);

        // Insert usage history
        await client.query(`
          INSERT INTO api_key_usage_history (
            key_id, timestamp, model, total_tokens, cost, credits_used
          ) VALUES (
            'test-key-2', ${Date.now()}, 'claude-opus-4', 1000, 0.05, 5000
          )
        `);

        // Verify history exists
        let result = await client.query(
          "SELECT COUNT(*) FROM api_key_usage_history WHERE key_id = 'test-key-2'"
        );
        expect(parseInt(result.rows[0].count)).toBe(1);

        // Delete the api_key
        await client.query("DELETE FROM api_keys WHERE id = 'test-key-2'");

        // Verify history was cascade deleted
        result = await client.query(
          "SELECT COUNT(*) FROM api_key_usage_history WHERE key_id = 'test-key-2'"
        );
        expect(parseInt(result.rows[0].count)).toBe(0);
      } finally {
        client.release();
      }
    });

    test("should store timestamp in milliseconds (BIGINT)", async () => {
      const client = await pool.connect();
      try {
        const nowMs = Date.now();

        await client.query(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES ('test-user-3', 'test3@example.com', 'hash123', ${nowMs})
          ON CONFLICT (id) DO NOTHING
        `);

        await client.query(`
          INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
          VALUES ('test-key-3', 'test-user-3', 'hash789', 'sk-test3', ${nowMs})
        `);

        await client.query(`
          INSERT INTO api_key_usage_history (
            key_id, timestamp, model, total_tokens, cost, credits_used
          ) VALUES (
            'test-key-3', ${nowMs}, 'claude-haiku-4', 1000, 0.001, 250
          )
        `);

        const result = await client.query(`
          SELECT timestamp FROM api_key_usage_history WHERE key_id = 'test-key-3'
        `);

        const storedTimestamp = parseInt(result.rows[0].timestamp);
        expect(storedTimestamp).toBe(nowMs);
        expect(storedTimestamp).toBeGreaterThan(1700000000000); // Should be > Nov 2023 in ms
      } finally {
        client.release();
      }
    });

    test("should store credits_used as BIGINT", async () => {
      const client = await pool.connect();
      try {
        await client.query(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES ('test-user-4', 'test4@example.com', 'hash123', ${Date.now()})
          ON CONFLICT (id) DO NOTHING
        `);

        await client.query(`
          INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
          VALUES ('test-key-4', 'test-user-4', 'hash000', 'sk-test4', ${Date.now()})
        `);

        const largeCredits = 10_000_000; // 10M credits
        await client.query(`
          INSERT INTO api_key_usage_history (
            key_id, timestamp, model, total_tokens, cost, credits_used
          ) VALUES (
            'test-key-4', ${Date.now()}, 'claude-opus-4', 2000000, 100.0, ${largeCredits}
          )
        `);

        const result = await client.query(`
          SELECT credits_used FROM api_key_usage_history WHERE key_id = 'test-key-4'
        `);

        expect(parseInt(result.rows[0].credits_used)).toBe(largeCredits);
      } finally {
        client.release();
      }
    });
  });

  describe("api_keys table plan_type column", () => {
    test("should have plan_type column", async () => {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT column_name, data_type, column_default
          FROM information_schema.columns
          WHERE table_name = 'api_keys' AND column_name = 'plan_type'
        `);

        expect(result.rows.length).toBe(1);
        expect(result.rows[0].data_type).toBe("character varying");
        expect(result.rows[0].column_default).toContain("'pro'"); // Default value should be 'pro'
      } finally {
        client.release();
      }
    });

    test("should accept valid plan type values", async () => {
      const client = await pool.connect();
      try {
        const validPlans: PlanType[] = ["free", "pro", "max-5x", "max-20x"];

        await client.query(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES ('test-user-plans', 'plans@example.com', 'hash123', ${Date.now()})
          ON CONFLICT (id) DO NOTHING
        `);

        for (const plan of validPlans) {
          await client.query(`
            INSERT INTO api_keys (id, user_id, key_hash, key_prefix, plan_type, created_at)
            VALUES ('test-key-${plan}', 'test-user-plans', 'hash-${plan}', 'sk-${plan}', '${plan}', ${Date.now()})
          `);

          const result = await client.query(`
            SELECT plan_type FROM api_keys WHERE id = 'test-key-${plan}'
          `);

          expect(result.rows[0].plan_type).toBe(plan);
        }
      } finally {
        client.release();
      }
    });

    test("should default to 'pro' when plan_type not specified", async () => {
      const client = await pool.connect();
      try {
        await client.query(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES ('test-user-default', 'default@example.com', 'hash123', ${Date.now()})
          ON CONFLICT (id) DO NOTHING
        `);

        await client.query(`
          INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
          VALUES ('test-key-default', 'test-user-default', 'hash-default', 'sk-default', ${Date.now()})
        `);

        const result = await client.query(`
          SELECT plan_type FROM api_keys WHERE id = 'test-key-default'
        `);

        expect(result.rows[0].plan_type).toBe("pro");
      } finally {
        client.release();
      }
    });

    test("existing keys should have 'pro' as default plan", async () => {
      const client = await pool.connect();
      try {
        // Insert a key without plan_type (simulating existing data)
        await client.query(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES ('test-user-existing', 'existing@example.com', 'hash123', ${Date.now()})
          ON CONFLICT (id) DO NOTHING
        `);

        await client.query(`
          INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
          VALUES ('test-key-existing', 'test-user-existing', 'hash-existing', 'sk-existing', ${Date.now()})
        `);

        const result = await client.query(`
          SELECT plan_type FROM api_keys WHERE id = 'test-key-existing'
        `);

        // Should have 'pro' from default
        expect(result.rows[0].plan_type).toBe("pro");
      } finally {
        client.release();
      }
    });
  });

  describe("Data Integrity", () => {
    test("should maintain referential integrity across tables", async () => {
      const client = await pool.connect();
      try {
        await client.query(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES ('integrity-user', 'integrity@example.com', 'hash123', ${Date.now()})
          ON CONFLICT (id) DO NOTHING
        `);

        await client.query(`
          INSERT INTO api_keys (id, user_id, key_hash, key_prefix, plan_type, created_at)
          VALUES ('integrity-key', 'integrity-user', 'hash-int', 'sk-int', 'max-5x', ${Date.now()})
        `);

        await client.query(`
          INSERT INTO api_key_usage_history (
            key_id, timestamp, model, total_tokens, cost, credits_used
          ) VALUES (
            'integrity-key', ${Date.now()}, 'claude-sonnet-4', 1000, 0.01, 1000
          )
        `);

        // Verify all data exists
        const userResult = await client.query(
          "SELECT * FROM users WHERE id = 'integrity-user'"
        );
        const keyResult = await client.query(
          "SELECT * FROM api_keys WHERE id = 'integrity-key'"
        );
        const historyResult = await client.query(
          "SELECT * FROM api_key_usage_history WHERE key_id = 'integrity-key'"
        );

        expect(userResult.rows.length).toBe(1);
        expect(keyResult.rows.length).toBe(1);
        expect(keyResult.rows[0].plan_type).toBe("max-5x");
        expect(historyResult.rows.length).toBe(1);
      } finally {
        client.release();
      }
    });

    test("should handle multiple history records for same key", async () => {
      const client = await pool.connect();
      try {
        await client.query(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES ('multi-user', 'multi@example.com', 'hash123', ${Date.now()})
          ON CONFLICT (id) DO NOTHING
        `);

        await client.query(`
          INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
          VALUES ('multi-key', 'multi-user', 'hash-multi', 'sk-multi', ${Date.now()})
        `);

        // Insert multiple history records
        const now = Date.now();
        for (let i = 0; i < 5; i++) {
          await client.query(`
            INSERT INTO api_key_usage_history (
              key_id, timestamp, model, total_tokens, cost, credits_used
            ) VALUES (
              'multi-key', ${now + i * 1000}, 'claude-sonnet-4', ${(i + 1) * 1000}, ${(i + 1) * 0.01}, ${(i + 1) * 1000}
            )
          `);
        }

        const result = await client.query(`
          SELECT COUNT(*) FROM api_key_usage_history WHERE key_id = 'multi-key'
        `);

        expect(parseInt(result.rows[0].count)).toBe(5);
      } finally {
        client.release();
      }
    });

    test("should efficiently query with index on (key_id, timestamp DESC)", async () => {
      const client = await pool.connect();
      try {
        await client.query(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES ('perf-user', 'perf@example.com', 'hash123', ${Date.now()})
          ON CONFLICT (id) DO NOTHING
        `);

        await client.query(`
          INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
          VALUES ('perf-key', 'perf-user', 'hash-perf', 'sk-perf', ${Date.now()})
        `);

        // Insert records with different timestamps
        const now = Date.now();
        for (let i = 0; i < 10; i++) {
          await client.query(`
            INSERT INTO api_key_usage_history (
              key_id, timestamp, model, total_tokens, cost, credits_used
            ) VALUES (
              'perf-key', ${now - i * 60000}, 'claude-sonnet-4', 1000, 0.01, 1000
            )
          `);
        }

        // Query with DESC order (should use index)
        const result = await client.query(`
          SELECT timestamp FROM api_key_usage_history
          WHERE key_id = 'perf-key'
          ORDER BY timestamp DESC
          LIMIT 5
        `);

        expect(result.rows.length).toBe(5);
        // Verify descending order
        for (let i = 0; i < result.rows.length - 1; i++) {
          expect(parseInt(result.rows[i].timestamp)).toBeGreaterThanOrEqual(
            parseInt(result.rows[i + 1].timestamp)
          );
        }
      } finally {
        client.release();
      }
    });
  });

  describe("Cleanup Function", () => {
    test("should clean up old usage history records based on retention days", async () => {
      const client = await pool.connect();
      try {
        // Create test user and key
        await client.query(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES ('cleanup-user', 'cleanup@example.com', 'hash123', ${Date.now()})
          ON CONFLICT (id) DO NOTHING
        `);

        await client.query(`
          INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
          VALUES ('cleanup-key', 'cleanup-user', 'hash-cleanup', 'sk-cleanup', ${Date.now()})
        `);

        const now = Date.now();
        const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
        const twentyNineDaysAgo = now - 29 * 24 * 60 * 60 * 1000;

        // Insert old record (31 days ago)
        await client.query(`
          INSERT INTO api_key_usage_history (
            key_id, timestamp, model, total_tokens, cost, credits_used
          ) VALUES (
            'cleanup-key', ${thirtyOneDaysAgo}, 'claude-sonnet-4', 1000, 0.01, 1000
          )
        `);

        // Insert recent record (29 days ago)
        await client.query(`
          INSERT INTO api_key_usage_history (
            key_id, timestamp, model, total_tokens, cost, credits_used
          ) VALUES (
            'cleanup-key', ${twentyNineDaysAgo}, 'claude-sonnet-4', 1000, 0.01, 1000
          )
        `);

        // Insert current record
        await client.query(`
          INSERT INTO api_key_usage_history (
            key_id, timestamp, model, total_tokens, cost, credits_used
          ) VALUES (
            'cleanup-key', ${now}, 'claude-sonnet-4', 1000, 0.01, 1000
          )
        `);

        // Verify all 3 records exist
        let result = await client.query(
          "SELECT COUNT(*) FROM api_key_usage_history WHERE key_id = 'cleanup-key'"
        );
        expect(parseInt(result.rows[0].count)).toBe(3);

        // Run cleanup with 30 days retention
        await cleanupOldUsageHistory(30);

        // Verify only old record (31 days) was deleted
        result = await client.query(
          "SELECT COUNT(*) FROM api_key_usage_history WHERE key_id = 'cleanup-key'"
        );
        expect(parseInt(result.rows[0].count)).toBe(2);

        // Verify the remaining records are the recent ones
        result = await client.query(`
          SELECT timestamp FROM api_key_usage_history
          WHERE key_id = 'cleanup-key'
          ORDER BY timestamp ASC
        `);
        expect(parseInt(result.rows[0].timestamp)).toBe(twentyNineDaysAgo);
        expect(parseInt(result.rows[1].timestamp)).toBe(now);
      } finally {
        client.release();
      }
    });

    test("should handle cleanup when no old records exist", async () => {
      const client = await pool.connect();
      try {
        await client.query(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES ('cleanup-user-2', 'cleanup2@example.com', 'hash123', ${Date.now()})
          ON CONFLICT (id) DO NOTHING
        `);

        await client.query(`
          INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
          VALUES ('cleanup-key-2', 'cleanup-user-2', 'hash-cleanup2', 'sk-cleanup2', ${Date.now()})
        `);

        // Insert only recent records
        const now = Date.now();
        await client.query(`
          INSERT INTO api_key_usage_history (
            key_id, timestamp, model, total_tokens, cost, credits_used
          ) VALUES (
            'cleanup-key-2', ${now}, 'claude-sonnet-4', 1000, 0.01, 1000
          )
        `);

        // Run cleanup
        await cleanupOldUsageHistory(30);

        // Verify record still exists
        const result = await client.query(
          "SELECT COUNT(*) FROM api_key_usage_history WHERE key_id = 'cleanup-key-2'"
        );
        expect(parseInt(result.rows[0].count)).toBe(1);
      } finally {
        client.release();
      }
    });

    test("should use custom retention period", async () => {
      const client = await pool.connect();
      try {
        await client.query(`
          INSERT INTO users (id, email, password_hash, created_at)
          VALUES ('cleanup-user-3', 'cleanup3@example.com', 'hash123', ${Date.now()})
          ON CONFLICT (id) DO NOTHING
        `);

        await client.query(`
          INSERT INTO api_keys (id, user_id, key_hash, key_prefix, created_at)
          VALUES ('cleanup-key-3', 'cleanup-user-3', 'hash-cleanup3', 'sk-cleanup3', ${Date.now()})
        `);

        const now = Date.now();
        const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

        await client.query(`
          INSERT INTO api_key_usage_history (
            key_id, timestamp, model, total_tokens, cost, credits_used
          ) VALUES (
            'cleanup-key-3', ${eightDaysAgo}, 'claude-sonnet-4', 1000, 0.01, 1000
          )
        `);

        // Cleanup with 7 days retention
        await cleanupOldUsageHistory(7);

        // Record should be deleted
        const result = await client.query(
          "SELECT COUNT(*) FROM api_key_usage_history WHERE key_id = 'cleanup-key-3'"
        );
        expect(parseInt(result.rows[0].count)).toBe(0);
      } finally {
        client.release();
      }
    });
  });
});
