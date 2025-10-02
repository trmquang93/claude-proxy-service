import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Pool } from "pg";
import { disconnectOAuth, hasOAuthConnection, saveOAuthTokens } from "../src/oauth";
import { randomUUID } from "crypto";

// Test database configuration
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL must be set for tests");
}

const testPool = new Pool({
  connectionString: TEST_DATABASE_URL,
  max: 5,
});

describe("OAuth Disconnect Functionality", () => {
  let testUserId: string;

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
    await testPool.query(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)",
      [testUserId, `test-${testUserId}@example.com`, "hashed_password", Date.now()]
    );
  });

  afterAll(async () => {
    // Clean up test data
    await testPool.query("DELETE FROM oauth_tokens WHERE user_id LIKE 'test-%'");
    await testPool.query("DELETE FROM users WHERE email LIKE 'test-%'");
    await testPool.end();
  });

  describe("disconnectOAuth", () => {
    test("should successfully disconnect OAuth when tokens exist", async () => {
      // Arrange: Save OAuth tokens for test user
      const mockTokens = {
        access_token: "test_access_token",
        refresh_token: "test_refresh_token",
        expires_at: Date.now() + 3600000,
      };
      await saveOAuthTokens(testUserId, mockTokens);

      // Verify tokens were saved
      const beforeDisconnect = await hasOAuthConnection(testUserId);
      expect(beforeDisconnect).toBe(true);

      // Act: Disconnect OAuth
      const result = await disconnectOAuth(testUserId);

      // Assert: Disconnect was successful
      expect(result.success).toBe(true);
      expect(result.rowsDeleted).toBe(1);

      // Verify tokens were deleted
      const afterDisconnect = await hasOAuthConnection(testUserId);
      expect(afterDisconnect).toBe(false);
    });

    test("should return false when no OAuth tokens exist", async () => {
      // Act: Try to disconnect when no tokens exist
      const result = await disconnectOAuth(testUserId);

      // Assert: Disconnect returns false
      expect(result.success).toBe(false);
      expect(result.rowsDeleted).toBe(0);
    });

    test("should not affect other users' OAuth tokens", async () => {
      // Arrange: Create another test user with OAuth tokens
      const otherUserId = randomUUID();
      await testPool.query(
        "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)",
        [otherUserId, `other-${otherUserId}@example.com`, "hashed_password", Date.now()]
      );

      const mockTokens = {
        access_token: "test_access_token",
        refresh_token: "test_refresh_token",
        expires_at: Date.now() + 3600000,
      };

      await saveOAuthTokens(testUserId, mockTokens);
      await saveOAuthTokens(otherUserId, mockTokens);

      // Act: Disconnect only the first user
      await disconnectOAuth(testUserId);

      // Assert: First user disconnected, other user still connected
      const firstUserConnected = await hasOAuthConnection(testUserId);
      const otherUserConnected = await hasOAuthConnection(otherUserId);

      expect(firstUserConnected).toBe(false);
      expect(otherUserConnected).toBe(true);

      // Cleanup
      await testPool.query("DELETE FROM oauth_tokens WHERE user_id = $1", [otherUserId]);
      await testPool.query("DELETE FROM users WHERE id = $1", [otherUserId]);
    });

    test("should handle multiple disconnect calls idempotently", async () => {
      // Arrange: Save OAuth tokens
      const mockTokens = {
        access_token: "test_access_token",
        refresh_token: "test_refresh_token",
        expires_at: Date.now() + 3600000,
      };
      await saveOAuthTokens(testUserId, mockTokens);

      // Act: Disconnect multiple times
      const firstDisconnect = await disconnectOAuth(testUserId);
      const secondDisconnect = await disconnectOAuth(testUserId);
      const thirdDisconnect = await disconnectOAuth(testUserId);

      // Assert: First succeeds, subsequent return false
      expect(firstDisconnect.success).toBe(true);
      expect(firstDisconnect.rowsDeleted).toBe(1);

      expect(secondDisconnect.success).toBe(false);
      expect(secondDisconnect.rowsDeleted).toBe(0);

      expect(thirdDisconnect.success).toBe(false);
      expect(thirdDisconnect.rowsDeleted).toBe(0);
    });
  });

  describe("hasOAuthConnection", () => {
    test("should return true when OAuth tokens exist", async () => {
      // Arrange
      const mockTokens = {
        access_token: "test_access_token",
        refresh_token: "test_refresh_token",
        expires_at: Date.now() + 3600000,
      };
      await saveOAuthTokens(testUserId, mockTokens);

      // Act
      const hasConnection = await hasOAuthConnection(testUserId);

      // Assert
      expect(hasConnection).toBe(true);
    });

    test("should return false when no OAuth tokens exist", async () => {
      // Act
      const hasConnection = await hasOAuthConnection(testUserId);

      // Assert
      expect(hasConnection).toBe(false);
    });

    test("should return false after disconnect", async () => {
      // Arrange
      const mockTokens = {
        access_token: "test_access_token",
        refresh_token: "test_refresh_token",
        expires_at: Date.now() + 3600000,
      };
      await saveOAuthTokens(testUserId, mockTokens);

      // Verify connected
      expect(await hasOAuthConnection(testUserId)).toBe(true);

      // Act: Disconnect
      await disconnectOAuth(testUserId);

      // Assert: Not connected anymore
      const hasConnection = await hasOAuthConnection(testUserId);
      expect(hasConnection).toBe(false);
    });
  });
});
