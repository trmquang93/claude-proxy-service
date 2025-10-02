import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Pool } from "pg";
import { randomUUID } from "crypto";
import { sign } from "jsonwebtoken";
import { saveOAuthTokens } from "../src/oauth";

// Test database configuration
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || "test-secret-key";
const API_BASE = "http://localhost:3000";

if (!TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL must be set for tests");
}

const testPool = new Pool({
  connectionString: TEST_DATABASE_URL,
  max: 5,
});

describe("OAuth Disconnect API Endpoint", () => {
  let testUserId: string;
  let testEmail: string;
  let authToken: string;

  beforeAll(async () => {
    // Ensure test database schema exists
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      )
    `);

    await testPool.query(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        user_id VARCHAR(255) PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  });

  beforeEach(async () => {
    // Create a test user before each test
    testUserId = randomUUID();
    testEmail = `test-${testUserId}@example.com`;

    await testPool.query(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)",
      [testUserId, testEmail, "hashed_password", Date.now()]
    );

    // Generate JWT token for test user
    authToken = sign({ userId: testUserId, email: testEmail }, JWT_SECRET, {
      expiresIn: "1h",
    });
  });

  afterAll(async () => {
    // Clean up test data
    await testPool.query("DELETE FROM oauth_tokens WHERE user_id LIKE $1", [testUserId]);
    await testPool.query("DELETE FROM users WHERE email LIKE 'test-%'");
    await testPool.end();
  });

  describe("DELETE /api/claude/disconnect", () => {
    test("should successfully disconnect when OAuth connection exists", async () => {
      // Arrange: Create OAuth connection for test user
      const mockTokens = {
        access_token: "test_access_token",
        refresh_token: "test_refresh_token",
        expires_at: Date.now() + 3600000,
      };
      await saveOAuthTokens(testUserId, mockTokens);

      // Verify connection exists
      const statusBefore = await fetch(`${API_BASE}/api/claude/status`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const statusDataBefore = await statusBefore.json();
      expect(statusDataBefore.connected).toBe(true);

      // Act: Disconnect OAuth
      const response = await fetch(`${API_BASE}/api/claude/disconnect`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      // Assert: Successful disconnect
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.message).toBe("Claude account disconnected");

      // Verify connection no longer exists
      const statusAfter = await fetch(`${API_BASE}/api/claude/status`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const statusDataAfter = await statusAfter.json();
      expect(statusDataAfter.connected).toBe(false);
    });

    test("should return 404 when no OAuth connection exists", async () => {
      // Act: Try to disconnect when no OAuth connection exists
      const response = await fetch(`${API_BASE}/api/claude/disconnect`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      // Assert: Returns 404
      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error).toBe("No OAuth connection found to disconnect");
    });

    test("should return 401 when no auth token provided", async () => {
      // Act: Try to disconnect without auth token
      const response = await fetch(`${API_BASE}/api/claude/disconnect`, {
        method: "DELETE",
      });

      // Assert: Returns 401 Unauthorized
      expect(response.status).toBe(401);
    });

    test("should return 401 when invalid auth token provided", async () => {
      // Act: Try to disconnect with invalid token
      const response = await fetch(`${API_BASE}/api/claude/disconnect`, {
        method: "DELETE",
        headers: {
          Authorization: "Bearer invalid_token_here",
        },
      });

      // Assert: Returns 401 Unauthorized
      expect(response.status).toBe(401);
    });

    test("should handle multiple disconnect requests idempotently", async () => {
      // Arrange: Create OAuth connection
      const mockTokens = {
        access_token: "test_access_token",
        refresh_token: "test_refresh_token",
        expires_at: Date.now() + 3600000,
      };
      await saveOAuthTokens(testUserId, mockTokens);

      // Act: Disconnect multiple times
      const firstResponse = await fetch(`${API_BASE}/api/claude/disconnect`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      const secondResponse = await fetch(`${API_BASE}/api/claude/disconnect`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      // Assert: First succeeds, second returns 404
      expect(firstResponse.status).toBe(200);
      const firstData = await firstResponse.json();
      expect(firstData.message).toBe("Claude account disconnected");

      expect(secondResponse.status).toBe(404);
      const secondData = await secondResponse.json();
      expect(secondData.error).toBe("No OAuth connection found to disconnect");
    });

    test("should not affect other users when one user disconnects", async () => {
      // Arrange: Create another test user with OAuth
      const otherUserId = randomUUID();
      const otherEmail = `other-${otherUserId}@example.com`;

      await testPool.query(
        "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)",
        [otherUserId, otherEmail, "hashed_password", Date.now()]
      );

      const otherAuthToken = sign(
        { userId: otherUserId, email: otherEmail },
        JWT_SECRET,
        { expiresIn: "1h" }
      );

      const mockTokens = {
        access_token: "test_access_token",
        refresh_token: "test_refresh_token",
        expires_at: Date.now() + 3600000,
      };

      await saveOAuthTokens(testUserId, mockTokens);
      await saveOAuthTokens(otherUserId, mockTokens);

      // Act: Disconnect first user
      await fetch(`${API_BASE}/api/claude/disconnect`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      // Assert: First user disconnected, other user still connected
      const statusFirstUser = await fetch(`${API_BASE}/api/claude/status`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const statusFirstUserData = await statusFirstUser.json();
      expect(statusFirstUserData.connected).toBe(false);

      const statusOtherUser = await fetch(`${API_BASE}/api/claude/status`, {
        headers: {
          Authorization: `Bearer ${otherAuthToken}`,
        },
      });
      const statusOtherUserData = await statusOtherUser.json();
      expect(statusOtherUserData.connected).toBe(true);

      // Cleanup
      await testPool.query("DELETE FROM oauth_tokens WHERE user_id = $1", [otherUserId]);
      await testPool.query("DELETE FROM users WHERE id = $1", [otherUserId]);
    });
  });
});
