import { validateApiKey } from "./keys";
import { ensureValidToken } from "./oauth";

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

    // 2. Validate API key and get user ID
    const keyValidation = await validateApiKey(apiKey);
    if (!keyValidation.valid || !keyValidation.userId) {
      return new Response(
        JSON.stringify({ error: "Invalid API key" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Get valid OAuth access token (refresh if needed)
    const tokenResult = await ensureValidToken(keyValidation.userId);
    if (!tokenResult.success || !tokenResult.accessToken) {
      return new Response(
        JSON.stringify({ error: "OAuth token not found or expired. Please reconnect Claude account." }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 4. Get request body
    const body = await request.json();

    // 5. Forward to Claude API
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

    // 6. Return Claude's response
    const responseData = await claudeResponse.json();
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
