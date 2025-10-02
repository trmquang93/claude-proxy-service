import pool from "./db";
import { calculateCost } from "./pricing";

export interface KeyUsage {
  key_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  total_cost: number;
  last_request_at: number | null;
  request_count: number;
}

export interface UsageUpdate {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Initialize usage tracking for a new API key
export async function initializeKeyUsage(keyId: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO api_key_usage (key_id) VALUES ($1)`,
      [keyId]
    );
  } catch (error) {
    console.error("[Usage] Initialize key usage error:", error);
    throw error;
  }
}

// Update usage metrics from Claude API response
export async function updateKeyUsage(keyId: string, usage: UsageUpdate): Promise<void> {
  try {
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const totalTokens = usage.input_tokens + usage.output_tokens + cacheCreation + cacheRead;

    // Calculate cost using dynamic pricing based on model
    const totalCost = calculateCost(usage.model, {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
    });

    const now = Math.floor(Date.now() / 1000);

    await pool.query(
      `UPDATE api_key_usage
       SET
         input_tokens = input_tokens + $1,
         output_tokens = output_tokens + $2,
         cache_creation_tokens = cache_creation_tokens + $3,
         cache_read_tokens = cache_read_tokens + $4,
         total_tokens = total_tokens + $5,
         total_cost = total_cost + $6,
         last_request_at = $7,
         request_count = request_count + 1
       WHERE key_id = $8`,
      [
        usage.input_tokens,
        usage.output_tokens,
        cacheCreation,
        cacheRead,
        totalTokens,
        totalCost,
        now,
        keyId
      ]
    );
  } catch (error) {
    console.error("[Usage] Update key usage error:", error);
    throw error;
  }
}

// Get usage for a specific API key
export async function getKeyUsage(keyId: string): Promise<KeyUsage | null> {
  try {
    const result = await pool.query(
      `SELECT * FROM api_key_usage WHERE key_id = $1`,
      [keyId]
    );
    const row = result.rows[0];
    if (!row) return null;

    // Parse numeric values to ensure they're numbers, not strings
    return {
      key_id: row.key_id,
      input_tokens: parseInt(row.input_tokens) || 0,
      output_tokens: parseInt(row.output_tokens) || 0,
      cache_creation_tokens: parseInt(row.cache_creation_tokens) || 0,
      cache_read_tokens: parseInt(row.cache_read_tokens) || 0,
      total_tokens: parseInt(row.total_tokens) || 0,
      total_cost: parseFloat(row.total_cost) || 0,
      last_request_at: row.last_request_at,
      request_count: parseInt(row.request_count) || 0,
    };
  } catch (error) {
    console.error("[Usage] Get key usage error:", error);
    return null;
  }
}

// Get aggregate usage across multiple keys (for a user's owned keys)
export async function getAggregateUsage(keyIds: string[]): Promise<KeyUsage> {
  if (keyIds.length === 0) {
    return {
      key_id: "",
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      total_cost: 0,
      last_request_at: null,
      request_count: 0,
    };
  }

  try {
    const placeholders = keyIds.map((_, i) => `$${i + 1}`).join(",");
    const result = await pool.query(
      `SELECT
         SUM(input_tokens) as input_tokens,
         SUM(output_tokens) as output_tokens,
         SUM(cache_creation_tokens) as cache_creation_tokens,
         SUM(cache_read_tokens) as cache_read_tokens,
         SUM(total_tokens) as total_tokens,
         SUM(total_cost) as total_cost,
         MAX(last_request_at) as last_request_at,
         SUM(request_count) as request_count
       FROM api_key_usage
       WHERE key_id IN (${placeholders})`,
      keyIds
    );

    const row = result.rows[0];
    return {
      key_id: "",
      input_tokens: parseInt(row.input_tokens) || 0,
      output_tokens: parseInt(row.output_tokens) || 0,
      cache_creation_tokens: parseInt(row.cache_creation_tokens) || 0,
      cache_read_tokens: parseInt(row.cache_read_tokens) || 0,
      total_tokens: parseInt(row.total_tokens) || 0,
      total_cost: parseFloat(row.total_cost) || 0,
      last_request_at: row.last_request_at,
      request_count: parseInt(row.request_count) || 0,
    };
  } catch (error) {
    console.error("[Usage] Get aggregate usage error:", error);
    return {
      key_id: "",
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      total_cost: 0,
      last_request_at: null,
      request_count: 0,
    };
  }
}

// Delete usage data for a key (called when key is deleted)
export async function deleteKeyUsage(keyId: string): Promise<void> {
  try {
    await pool.query(
      `DELETE FROM api_key_usage WHERE key_id = $1`,
      [keyId]
    );
  } catch (error) {
    console.error("[Usage] Delete key usage error:", error);
  }
}
