import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "crypto";
import pool from "./db";
import { initializeKeyUsage } from "./usage";

export interface ApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  name: string | null;
  is_active: boolean;
  created_at: number;
  assigned_to_email: string | null;
  assigned_to_user_id: string | null;
  assignment_status: string;
  invitation_token: string | null;
}

// Generate a new API key
export async function generateApiKey(userId: string, name?: string): Promise<{ success: boolean; key?: string; prefix?: string; error?: string }> {
  try {
    const keyId = randomUUID();
    const randomPart = randomBytes(32).toString("hex");
    const key = `sk-proj-${randomPart}`;
    const keyHash = await bcrypt.hash(key, 10);
    const keyPrefix = `${key.substring(0, 15)}...`;

    await pool.query(
      `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name)
       VALUES ($1, $2, $3, $4, $5)`,
      [keyId, userId, keyHash, keyPrefix, name || null]
    );

    // Initialize usage tracking for the new key
    await initializeKeyUsage(keyId);

    return {
      success: true,
      key,
      prefix: keyPrefix,
    };
  } catch (error) {
    console.error("[Keys] Generate API key error:", error);
    return { success: false, error: "Failed to generate API key" };
  }
}

// Validate API key and return user ID and key ID
export async function validateApiKey(key: string): Promise<{ valid: boolean; userId?: string; keyId?: string; error?: string }> {
  try {
    const result = await pool.query("SELECT * FROM api_keys WHERE is_active = true", []);
    const allKeys = result.rows as ApiKey[];

    for (const apiKey of allKeys) {
      const isValid = await bcrypt.compare(key, apiKey.key_hash);
      if (isValid) {
        return {
          valid: true,
          userId: apiKey.user_id,
          keyId: apiKey.id,
        };
      }
    }

    return { valid: false, error: "Invalid API key" };
  } catch (error) {
    console.error("[Keys] Validate API key error:", error);
    return { valid: false, error: "API key validation failed" };
  }
}

// List user's API keys
export async function listApiKeys(userId: string): Promise<ApiKey[]> {
  try {
    const result = await pool.query(
      "SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );
    return result.rows as ApiKey[];
  } catch (error) {
    console.error("[Keys] List API keys error:", error);
    return [];
  }
}

// Revoke API key
export async function revokeApiKey(keyId: string, userId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      "UPDATE api_keys SET is_active = false WHERE id = $1 AND user_id = $2",
      [keyId, userId]
    );
    return (result.rowCount || 0) > 0;
  } catch (error) {
    console.error("[Keys] Revoke API key error:", error);
    return false;
  }
}

// Delete API key
export async function deleteApiKey(keyId: string, userId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      "DELETE FROM api_keys WHERE id = $1 AND user_id = $2",
      [keyId, userId]
    );
    return (result.rowCount || 0) > 0;
  } catch (error) {
    console.error("[Keys] Delete API key error:", error);
    return false;
  }
}

// Assign API key to a user by email
export async function assignKey(keyId: string, ownerId: string, email: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { success: false, error: "Invalid email format" };
    }

    // Check if key exists and belongs to the owner
    const keyResult = await pool.query(
      "SELECT * FROM api_keys WHERE id = $1 AND user_id = $2",
      [keyId, ownerId]
    );
    const key = keyResult.rows[0] as ApiKey | undefined;

    if (!key) {
      return { success: false, error: "API key not found or you don't have permission" };
    }

    // Check if owner already assigned a key to this email
    const existingResult = await pool.query(
      `SELECT id FROM api_keys
       WHERE user_id = $1
       AND assigned_to_email = $2
       AND is_active = true`,
      [ownerId, email]
    );

    if (existingResult.rows.length > 0) {
      return { success: false, error: "You have already assigned a key to this email address" };
    }

    // Generate invitation token
    const invitationToken = randomUUID();

    // Update key with assignment details
    await pool.query(
      `UPDATE api_keys
       SET assigned_to_email = $1,
           assignment_status = 'pending',
           invitation_token = $2
       WHERE id = $3`,
      [email, invitationToken, keyId]
    );

    // TODO: Send email with invitation link
    console.log(`Invitation link: /api/keys/accept-invitation/${invitationToken}`);

    return { success: true };
  } catch (error) {
    console.error("assignKey error:", error);
    return { success: false, error: "Failed to assign key" };
  }
}

// Accept key invitation
export async function acceptInvitation(token: string, userId: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Find key by invitation token
    const keyResult = await pool.query(
      `SELECT * FROM api_keys
       WHERE invitation_token = $1
       AND assignment_status = 'pending'
       AND is_active = true`,
      [token]
    );
    const key = keyResult.rows[0] as ApiKey | undefined;

    if (!key) {
      return { success: false, error: "Invalid or expired invitation" };
    }

    // Get user email
    const userResult = await pool.query("SELECT email FROM users WHERE id = $1", [userId]);
    const user = userResult.rows[0] as { email: string } | undefined;

    if (!user) {
      return { success: false, error: "User not found" };
    }

    // Verify email matches
    if (key.assigned_to_email !== user.email) {
      return { success: false, error: "This invitation was sent to a different email address" };
    }

    // Update key to accepted status
    await pool.query(
      `UPDATE api_keys
       SET assigned_to_user_id = $1,
           assignment_status = 'accepted'
       WHERE id = $2`,
      [userId, key.id]
    );

    return { success: true };
  } catch (error) {
    console.error("acceptInvitation error:", error);
    return { success: false, error: "Failed to accept invitation" };
  }
}

// Get pending invitations for a user's email
export async function getPendingInvitations(email: string): Promise<ApiKey[]> {
  try {
    const result = await pool.query(
      `SELECT * FROM api_keys
       WHERE assigned_to_email = $1
       AND assignment_status = 'pending'
       AND is_active = true
       ORDER BY created_at DESC`,
      [email]
    );
    return result.rows as ApiKey[];
  } catch (error) {
    console.error("[Keys] Get pending invitations error:", error);
    return [];
  }
}

// List all keys accessible to a user (owned + assigned)
export async function listAllUserKeys(userId: string): Promise<{ owned: ApiKey[], assigned: ApiKey[] }> {
  try {
    const ownedResult = await pool.query(
      `SELECT * FROM api_keys
       WHERE user_id = $1
       AND is_active = true
       ORDER BY created_at DESC`,
      [userId]
    );
    const owned = ownedResult.rows as ApiKey[];

    const assignedResult = await pool.query(
      `SELECT * FROM api_keys
       WHERE assigned_to_user_id = $1
       AND is_active = true
       ORDER BY created_at DESC`,
      [userId]
    );
    const assigned = assignedResult.rows as ApiKey[];

    return { owned, assigned };
  } catch (error) {
    console.error("[Keys] List all user keys error:", error);
    return { owned: [], assigned: [] };
  }
}
