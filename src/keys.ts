import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "crypto";
import db from "./db";
import { initializeKeyUsage } from "./usage";

export interface ApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  name: string | null;
  is_active: number;
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

    db.query(`
      INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name)
      VALUES (?, ?, ?, ?, ?)
    `).run(keyId, userId, keyHash, keyPrefix, name || null);

    // Initialize usage tracking for the new key
    initializeKeyUsage(keyId);

    return {
      success: true,
      key,
      prefix: keyPrefix,
    };
  } catch (error) {
    return { success: false, error: "Failed to generate API key" };
  }
}

// Validate API key and return user ID and key ID
export async function validateApiKey(key: string): Promise<{ valid: boolean; userId?: string; keyId?: string; error?: string }> {
  try {
    const allKeys = db.query("SELECT * FROM api_keys WHERE is_active = 1").all() as ApiKey[];

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

// Assign API key to a user by email
export async function assignKey(keyId: string, ownerId: string, email: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { success: false, error: "Invalid email format" };
    }

    // Check if key exists and belongs to the owner
    const key = db.query("SELECT * FROM api_keys WHERE id = ? AND user_id = ?").get(keyId, ownerId) as ApiKey | undefined;
    if (!key) {
      return { success: false, error: "API key not found or you don't have permission" };
    }

    // Check if owner already assigned a key to this email
    const existingAssignment = db.query(`
      SELECT id FROM api_keys
      WHERE user_id = ?
      AND assigned_to_email = ?
      AND is_active = 1
    `).get(ownerId, email) as { id: string } | undefined;

    if (existingAssignment) {
      return { success: false, error: "You have already assigned a key to this email address" };
    }

    // Generate invitation token
    const invitationToken = randomUUID();

    // Update key with assignment details
    db.query(`
      UPDATE api_keys
      SET assigned_to_email = ?,
          assignment_status = 'pending',
          invitation_token = ?
      WHERE id = ?
    `).run(email, invitationToken, keyId);

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
    const key = db.query(`
      SELECT * FROM api_keys
      WHERE invitation_token = ?
      AND assignment_status = 'pending'
      AND is_active = 1
    `).get(token) as ApiKey | undefined;

    if (!key) {
      return { success: false, error: "Invalid or expired invitation" };
    }

    // Get user email
    const user = db.query("SELECT email FROM users WHERE id = ?").get(userId) as { email: string } | undefined;
    if (!user) {
      return { success: false, error: "User not found" };
    }

    // Verify email matches
    if (key.assigned_to_email !== user.email) {
      return { success: false, error: "This invitation was sent to a different email address" };
    }

    // Update key to accepted status
    db.query(`
      UPDATE api_keys
      SET assigned_to_user_id = ?,
          assignment_status = 'accepted'
      WHERE id = ?
    `).run(userId, key.id);

    return { success: true };
  } catch (error) {
    console.error("acceptInvitation error:", error);
    return { success: false, error: "Failed to accept invitation" };
  }
}

// Get pending invitations for a user's email
export function getPendingInvitations(email: string): ApiKey[] {
  return db.query(`
    SELECT * FROM api_keys
    WHERE assigned_to_email = ?
    AND assignment_status = 'pending'
    AND is_active = 1
    ORDER BY created_at DESC
  `).all(email) as ApiKey[];
}

// List all keys accessible to a user (owned + assigned)
export function listAllUserKeys(userId: string): { owned: ApiKey[], assigned: ApiKey[] } {
  const owned = db.query(`
    SELECT * FROM api_keys
    WHERE user_id = ?
    AND is_active = 1
    ORDER BY created_at DESC
  `).all(userId) as ApiKey[];

  const assigned = db.query(`
    SELECT * FROM api_keys
    WHERE assigned_to_user_id = ?
    AND is_active = 1
    ORDER BY created_at DESC
  `).all(userId) as ApiKey[];

  return { owned, assigned };
}
