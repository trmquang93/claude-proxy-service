import { validateApiKey } from "./keys";
import { ensureValidToken, hasOAuthConnection } from "./oauth";
import { updateKeyUsage } from "./usage";
import pool from "./db";

// Proxy request to Claude API
export async function proxyToClaudeAPI(request: Request): Promise<Response> {
  try {
    // 1. Extract API key from Authorization header
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid authorization header" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const apiKey = authHeader.replace("Bearer ", "");

    // 2. Validate API key and get user ID (owner of the key)
    const keyValidation = await validateApiKey(apiKey);
    if (!keyValidation.valid || !keyValidation.userId || !keyValidation.keyId) {
      return new Response(
        JSON.stringify({ error: "Invalid API key" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Check if key owner has active OAuth connection
    const hasConnection = await hasOAuthConnection(keyValidation.userId);
    if (!hasConnection) {
      // Get owner email for better error message
      const ownerResult = await pool.query("SELECT email FROM users WHERE id = $1", [keyValidation.userId]);
      const owner = ownerResult.rows[0] as { email: string } | undefined;
      const ownerEmail = owner?.email || "the key provider";

      return new Response(
        JSON.stringify({
          error: {
            type: "authentication_error",
            message: `The provider of this API key (${ownerEmail}) has disconnected their Claude account. Please contact them to resolve this issue.`
          }
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 4. Get valid OAuth access token (refresh if needed)
    const tokenResult = await ensureValidToken(keyValidation.userId);
    if (!tokenResult.success || !tokenResult.accessToken) {
      return new Response(
        JSON.stringify({ error: "OAuth token not found or expired. Please reconnect Claude account." }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 5. Get request body
    const body = await request.json();

    // 6. Forward to Claude API
    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${tokenResult.accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    // 7. Get Claude's response
    const responseData = await claudeResponse.json();

    // 8. Track usage if response is successful and contains usage data
    if (claudeResponse.ok && responseData.usage) {
      try {
        await updateKeyUsage(keyValidation.keyId, {
          input_tokens: responseData.usage.input_tokens || 0,
          output_tokens: responseData.usage.output_tokens || 0,
          cache_creation_input_tokens: responseData.usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: responseData.usage.cache_read_input_tokens || 0,
        });
      } catch (usageError) {
        console.error("Failed to update usage:", usageError);
        // Don't fail the request if usage tracking fails
      }
    }

    // 9. Return Claude's response
    return new Response(JSON.stringify(responseData), {
      status: claudeResponse.status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Proxy error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
