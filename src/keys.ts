import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "crypto";
import db from "./db";

export interface ApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  name: string | null;
  is_active: number;
  created_at: number;
}

// Generate a new API key
export async function generateApiKey(userId: string, name?: string): Promise<{ success: boolean; key?: string; prefix?: string; error?: string }> {
  try {
    const keyId = randomUUID();
    const randomPart = randomBytes(32).toString("hex");
    const key = `sk-proj-${randomPart}`;
    const keyHash = await bcrypt.hash(key, 10);
    const keyPrefix = `${key.substring(0, 15)}...`;

    db.query(`
      INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name)
      VALUES (?, ?, ?, ?, ?)
    `).run(keyId, userId, keyHash, keyPrefix, name || null);

    return {
      success: true,
      key,
      prefix: keyPrefix,
    };
  } catch (error) {
    return { success: false, error: "Failed to generate API key" };
  }
}

// Validate API key and return user ID
export async function validateApiKey(key: string): Promise<{ valid: boolean; userId?: string; error?: string }> {
  try {
    const allKeys = db.query("SELECT * FROM api_keys WHERE is_active = 1").all() as ApiKey[];

    for (const apiKey of allKeys) {
      const isValid = await bcrypt.compare(key, apiKey.key_hash);
      if (isValid) {
        return {
          valid: true,
          userId: apiKey.user_id,
        };
      }
    }

    return { valid: false, error: "Invalid API key" };
  } catch (error) {
    return { valid: false, error: "API key validation failed" };
  }
}

// List user's API keys
export function listApiKeys(userId: string): ApiKey[] {
  return db.query("SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC").all(userId) as ApiKey[];
}

// Revoke API key
export function revokeApiKey(keyId: string, userId: string): boolean {
  const result = db.query("UPDATE api_keys SET is_active = 0 WHERE id = ? AND user_id = ?").run(keyId, userId);
  return result.changes > 0;
}

// Delete API key
export function deleteApiKey(keyId: string, userId: string): boolean {
  const result = db.query("DELETE FROM api_keys WHERE id = ? AND user_id = ?").run(keyId, userId);
  return result.changes > 0;
}
