import db from "./db";

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
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Initialize usage tracking for a new API key
export function initializeKeyUsage(keyId: string): void {
  db.query(`
    INSERT INTO api_key_usage (key_id)
    VALUES (?)
  `).run(keyId);
}

// Update usage metrics from Claude API response
export function updateKeyUsage(keyId: string, usage: UsageUpdate): void {
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const totalTokens = usage.input_tokens + usage.output_tokens + cacheCreation + cacheRead;

  // Approximate cost calculation (based on Claude 3.5 Sonnet pricing)
  // Input: $3 per million tokens
  // Output: $15 per million tokens
  // Cache write: $3.75 per million tokens
  // Cache read: $0.30 per million tokens
  const inputCost = (usage.input_tokens / 1_000_000) * 3;
  const outputCost = (usage.output_tokens / 1_000_000) * 15;
  const cacheWriteCost = (cacheCreation / 1_000_000) * 3.75;
  const cacheReadCost = (cacheRead / 1_000_000) * 0.30;
  const totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;

  const now = Math.floor(Date.now() / 1000);

  db.query(`
    UPDATE api_key_usage
    SET
      input_tokens = input_tokens + ?,
      output_tokens = output_tokens + ?,
      cache_creation_tokens = cache_creation_tokens + ?,
      cache_read_tokens = cache_read_tokens + ?,
      total_tokens = total_tokens + ?,
      total_cost = total_cost + ?,
      last_request_at = ?,
      request_count = request_count + 1
    WHERE key_id = ?
  `).run(
    usage.input_tokens,
    usage.output_tokens,
    cacheCreation,
    cacheRead,
    totalTokens,
    totalCost,
    now,
    keyId
  );
}

// Get usage for a specific API key
export function getKeyUsage(keyId: string): KeyUsage | null {
  const result = db.query(`
    SELECT * FROM api_key_usage WHERE key_id = ?
  `).get(keyId) as KeyUsage | undefined;

  return result || null;
}

// Get aggregate usage across multiple keys (for a user's owned keys)
export function getAggregateUsage(keyIds: string[]): KeyUsage {
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

  const placeholders = keyIds.map(() => "?").join(",");
  const result = db.query(`
    SELECT
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cache_creation_tokens) as cache_creation_tokens,
      SUM(cache_read_tokens) as cache_read_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(total_cost) as total_cost,
      MAX(last_request_at) as last_request_at,
      SUM(request_count) as request_count
    FROM api_key_usage
    WHERE key_id IN (${placeholders})
  `).get(...keyIds) as any;

  return {
    key_id: "",
    input_tokens: result.input_tokens || 0,
    output_tokens: result.output_tokens || 0,
    cache_creation_tokens: result.cache_creation_tokens || 0,
    cache_read_tokens: result.cache_read_tokens || 0,
    total_tokens: result.total_tokens || 0,
    total_cost: result.total_cost || 0,
    last_request_at: result.last_request_at,
    request_count: result.request_count || 0,
  };
}

// Delete usage data for a key (called when key is deleted)
export function deleteKeyUsage(keyId: string): void {
  db.query(`
    DELETE FROM api_key_usage WHERE key_id = ?
  `).run(keyId);
}
