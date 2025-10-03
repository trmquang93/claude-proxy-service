import { describe, it, expect, beforeEach } from "bun:test";
import { app } from "../src/index";
import pool from "../src/db";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-key";

describe("User Plan API Endpoints", () => {
  let testUserId: string;
  let testToken: string;

  beforeEach(async () => {
    // Create a test user with default plan
    testUserId = randomUUID();
    const email = `test-${testUserId}@example.com`;
    const passwordHash = await bcrypt.hash("password123", 10);

    await pool.query(
      `INSERT INTO users (id, email, password_hash, plan_type) VALUES ($1, $2, $3, $4)`,
      [testUserId, email, passwordHash, "pro"]
    );

    // Generate JWT token for the test user
    testToken = jwt.sign({ userId: testUserId }, JWT_SECRET, { expiresIn: "1h" });
  });

  describe("GET /api/user/plan", () => {
    it("should return user's current plan", async () => {
      const response = await app.request("/api/user/plan", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${testToken}`,
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.plan).toBe("pro");
    });

    it("should return 401 without authentication", async () => {
      const response = await app.request("/api/user/plan", {
        method: "GET",
      });

      expect(response.status).toBe(401);
    });
  });

  describe("PATCH /api/user/plan", () => {
    it("should successfully update user's plan to 'free'", async () => {
      const response = await app.request("/api/user/plan", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${testToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ plan: "free" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toContain("updated");

      // Verify in database
      const userResult = await pool.query(
        `SELECT plan_type FROM users WHERE id = $1`,
        [testUserId]
      );
      expect(userResult.rows[0].plan_type).toBe("free");
    });

    it("should successfully update user's plan to 'max-5x'", async () => {
      const response = await app.request("/api/user/plan", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${testToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ plan: "max-5x" }),
      });

      expect(response.status).toBe(200);

      // Verify in database
      const userResult = await pool.query(
        `SELECT plan_type FROM users WHERE id = $1`,
        [testUserId]
      );
      expect(userResult.rows[0].plan_type).toBe("max-5x");
    });

    it("should successfully update user's plan to 'max-20x'", async () => {
      const response = await app.request("/api/user/plan", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${testToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ plan: "max-20x" }),
      });

      expect(response.status).toBe(200);

      // Verify in database
      const userResult = await pool.query(
        `SELECT plan_type FROM users WHERE id = $1`,
        [testUserId]
      );
      expect(userResult.rows[0].plan_type).toBe("max-20x");
    });

    it("should reject invalid plan type", async () => {
      const response = await app.request("/api/user/plan", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${testToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ plan: "invalid-plan" }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain("Invalid plan");

      // Verify plan was not changed
      const userResult = await pool.query(
        `SELECT plan_type FROM users WHERE id = $1`,
        [testUserId]
      );
      expect(userResult.rows[0].plan_type).toBe("pro");
    });

    it("should return 400 when plan is missing", async () => {
      const response = await app.request("/api/user/plan", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${testToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });

    it("should return 401 without authentication", async () => {
      const response = await app.request("/api/user/plan", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ plan: "free" }),
      });

      expect(response.status).toBe(401);
    });
  });
});
