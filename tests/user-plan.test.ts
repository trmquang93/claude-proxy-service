import { describe, it, expect, beforeEach } from "bun:test";
import pool from "../src/db";
import { getUserPlan, updateUserPlan } from "../src/keys";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";

describe("User Plan Management", () => {
  let testUserId: string;

  beforeEach(async () => {
    // Create a test user with default plan
    testUserId = randomUUID();
    const email = `test-${testUserId}@example.com`;
    const passwordHash = await bcrypt.hash("password123", 10);

    await pool.query(
      `INSERT INTO users (id, email, password_hash, plan_type) VALUES ($1, $2, $3, $4)`,
      [testUserId, email, passwordHash, "pro"]
    );
  });

  describe("getUserPlan()", () => {
    it("should return user's plan type", async () => {
      const result = await getUserPlan(testUserId);

      expect(result.success).toBe(true);
      expect(result.planType).toBe("pro");
    });

    it("should return error for non-existent user", async () => {
      const nonExistentId = randomUUID();
      const result = await getUserPlan(nonExistentId);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should default to 'pro' if plan_type is null", async () => {
      // Update user to have null plan_type
      await pool.query(
        `UPDATE users SET plan_type = NULL WHERE id = $1`,
        [testUserId]
      );

      const result = await getUserPlan(testUserId);

      expect(result.success).toBe(true);
      expect(result.planType).toBe("pro");
    });
  });

  describe("updateUserPlan()", () => {
    it("should successfully update user's plan to 'free'", async () => {
      const result = await updateUserPlan(testUserId, "free");

      expect(result.success).toBe(true);

      // Verify in database
      const userResult = await pool.query(
        `SELECT plan_type FROM users WHERE id = $1`,
        [testUserId]
      );
      expect(userResult.rows[0].plan_type).toBe("free");
    });

    it("should successfully update user's plan to 'max-5x'", async () => {
      const result = await updateUserPlan(testUserId, "max-5x");

      expect(result.success).toBe(true);

      // Verify in database
      const userResult = await pool.query(
        `SELECT plan_type FROM users WHERE id = $1`,
        [testUserId]
      );
      expect(userResult.rows[0].plan_type).toBe("max-5x");
    });

    it("should successfully update user's plan to 'max-20x'", async () => {
      const result = await updateUserPlan(testUserId, "max-20x");

      expect(result.success).toBe(true);

      // Verify in database
      const userResult = await pool.query(
        `SELECT plan_type FROM users WHERE id = $1`,
        [testUserId]
      );
      expect(userResult.rows[0].plan_type).toBe("max-20x");
    });

    it("should reject invalid plan type", async () => {
      const result = await updateUserPlan(testUserId, "invalid-plan" as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid plan type");

      // Verify plan was not changed
      const userResult = await pool.query(
        `SELECT plan_type FROM users WHERE id = $1`,
        [testUserId]
      );
      expect(userResult.rows[0].plan_type).toBe("pro");
    });

    it("should return error for non-existent user", async () => {
      const nonExistentId = randomUUID();
      const result = await updateUserPlan(nonExistentId, "free");

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
