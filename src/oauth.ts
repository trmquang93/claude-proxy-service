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
    const splits = code.split("#");
    const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: splits[0],
        state: splits[1],
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: "https://console.anthropic.com/oauth/code/callback",
        code_verifier: verifier,
      }),
    });

    if (!response.ok) {
      return { success: false, error: "Failed to exchange code" };
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
    return { success: false, error: "Token exchange failed" };
  }
}

// Save OAuth tokens for user
export function saveOAuthTokens(userId: string, tokens: { access_token: string; refresh_token: string; expires_at: number }): void {
  db.query(`
    INSERT OR REPLACE INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, tokens.access_token, tokens.refresh_token, tokens.expires_at, Date.now());
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
