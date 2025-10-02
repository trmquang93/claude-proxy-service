import { generatePKCE } from "@openauthjs/openauth/pkce";
import db from "./db";

const CLIENT_ID = process.env.CLAUDE_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export interface OAuthToken {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  updated_at: number;
}

// Generate OAuth authorization URL
export async function generateAuthUrl(): Promise<{ url: string; verifier: string }> {
  const pkce = await generatePKCE();

  const url = new URL("https://claude.ai/oauth/authorize");
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", "https://console.anthropic.com/oauth/code/callback");
  url.searchParams.set("scope", "org:create_api_key user:profile user:inference");
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);

  return {
    url: url.toString(),
    verifier: pkce.verifier,
  };
}

// Exchange authorization code for tokens
export async function exchangeCode(code: string, verifier: string): Promise<{ success: boolean; tokens?: any; error?: string }> {
  try {
    console.log("[OAuth] Starting token exchange");
    console.log("[OAuth] Code format check - contains '#':", code.includes("#"));

    const splits = code.split("#");
    const authCode = splits[0];
    const state = splits[1];

    console.log("[OAuth] Parsed code - length:", authCode?.length, "state:", state?.length || "none");

    const requestBody = {
      code: authCode,
      state: state,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    };

    console.log("[OAuth] Sending token exchange request to Anthropic");
    const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    console.log("[OAuth] Token exchange response status:", response.status, response.statusText);

    if (!response.ok) {
      let errorDetails = "Unknown error";
      try {
        const errorBody = await response.text();
        console.error("[OAuth] Token exchange failed with body:", errorBody);
        errorDetails = errorBody;
      } catch (e) {
        console.error("[OAuth] Could not read error response body");
      }
      return {
        success: false,
        error: `OAuth token exchange failed: ${response.status} ${response.statusText} - ${errorDetails}`
      };
    }

    let tokens;
    try {
      tokens = await response.json();
      console.log("[OAuth] Token exchange successful, received fields:", Object.keys(tokens));
    } catch (parseError) {
      console.error("[OAuth] Failed to parse token response JSON:", parseError);
      return { success: false, error: "Invalid JSON response from OAuth provider" };
    }

    // Validate required fields
    if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_in) {
      console.error("[OAuth] Missing required token fields:", {
        has_access_token: !!tokens.access_token,
        has_refresh_token: !!tokens.refresh_token,
        has_expires_in: !!tokens.expires_in
      });
      return { success: false, error: "OAuth response missing required fields" };
    }

    console.log("[OAuth] Token exchange completed successfully");
    return {
      success: true,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
      },
    };
  } catch (error) {
    console.error("[OAuth] Unexpected error during token exchange:", error);
    return {
      success: false,
      error: `Token exchange failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// Save OAuth tokens for user
export function saveOAuthTokens(userId: string, tokens: { access_token: string; refresh_token: string; expires_at: number }): void {
  try {
    console.log("[DB] Saving OAuth tokens for user:", userId);

    if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_at) {
      throw new Error("Invalid token data: missing required fields");
    }

    db.query(`
      INSERT OR REPLACE INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, tokens.access_token, tokens.refresh_token, tokens.expires_at, Date.now());

    console.log("[DB] OAuth tokens saved successfully for user:", userId);
  } catch (error) {
    console.error("[DB] Failed to save OAuth tokens:", error);
    throw new Error(`Database error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Get OAuth tokens for user
export function getOAuthTokens(userId: string): OAuthToken | null {
  return db.query("SELECT * FROM oauth_tokens WHERE user_id = ?").get(userId) as OAuthToken | null;
}

// Refresh access token
export async function refreshAccessToken(refreshToken: string): Promise<{ success: boolean; tokens?: any; error?: string }> {
  try {
    const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });

    if (!response.ok) {
      return { success: false, error: "Failed to refresh token" };
    }

    const tokens = await response.json();
    return {
      success: true,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
      },
    };
  } catch (error) {
    return { success: false, error: "Token refresh failed" };
  }
}

// Ensure valid access token (refresh if needed)
export async function ensureValidToken(userId: string): Promise<{ success: boolean; accessToken?: string; error?: string }> {
  const oauthTokens = getOAuthTokens(userId);

  if (!oauthTokens) {
    return { success: false, error: "No OAuth tokens found" };
  }

  // Check if token is expired
  if (oauthTokens.expires_at < Date.now()) {
    const refreshResult = await refreshAccessToken(oauthTokens.refresh_token);
    if (!refreshResult.success) {
      return { success: false, error: refreshResult.error };
    }

    // Update tokens in database
    saveOAuthTokens(userId, refreshResult.tokens);
    return { success: true, accessToken: refreshResult.tokens.access_token };
  }

  return { success: true, accessToken: oauthTokens.access_token };
}

// Check if user has connected Claude OAuth
export function hasOAuthConnection(userId: string): boolean {
  const tokens = getOAuthTokens(userId);
  return tokens !== null;
}

// Disconnect OAuth (remove tokens)
export function disconnectOAuth(userId: string): void {
  db.query("DELETE FROM oauth_tokens WHERE user_id = ?").run(userId);
}
