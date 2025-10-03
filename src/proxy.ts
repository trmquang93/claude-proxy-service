import { validateApiKey } from "./keys";
import { ensureValidToken, hasOAuthConnection } from "./oauth";
import { updateKeyUsage } from "./usage";
import pool from "./db";
import { checkQuotaLimit, formatDuration } from "./quota";
import { PLAN_LIMITS } from "./limits";

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

    // 4. Get plan type from user (owner of the key) and check quota BEFORE proxying
    const userResult = await pool.query(
      "SELECT plan_type FROM users WHERE id = $1",
      [keyValidation.userId]
    );
    const planType = userResult.rows[0]?.plan_type || 'pro';

    const quotaCheck = await checkQuotaLimit(keyValidation.keyId, planType);

    if (!quotaCheck.allowed) {
      return new Response(
        JSON.stringify({
          error: {
            type: "rate_limit_error",
            message: quotaCheck.reason,
            quota_exceeded: {
              usage_percentage: quotaCheck.percentages.maxPercentage,
              reset_at: quotaCheck.resetTime.toISOString(),
              time_until_reset: formatDuration(quotaCheck.usage.timeUntilResetMs)
            }
          }
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": Math.ceil(quotaCheck.usage.timeUntilResetMs / 1000).toString(),
            "X-RateLimit-Limit": PLAN_LIMITS[planType].creditsPerWindow.toString(),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": quotaCheck.resetTime.toISOString()
          }
        }
      );
    }

    // 5. Get valid OAuth access token (refresh if needed)
    const tokenResult = await ensureValidToken(keyValidation.userId);
    if (!tokenResult.success || !tokenResult.accessToken) {
      return new Response(
        JSON.stringify({ error: "OAuth token not found or expired. Please reconnect Claude account." }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 6. Get request body
    let body;
    try {
      const contentType = request.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        return new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: "Content-Type must be application/json"
            }
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      body = await request.json();

      // Validate required fields
      if (!body || typeof body !== 'object') {
        return new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: "Request body must be a JSON object"
            }
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    } catch (error) {
      console.error("Failed to parse request body:", error);
      return new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: "Invalid JSON in request body"
          }
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 7. Forward to Claude API
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

    // 8. Get Claude's response
    const responseData = await claudeResponse.json();

    // 9. Track usage if response is successful and contains usage data
    if (claudeResponse.ok && responseData.usage) {
      try {
        await updateKeyUsage(keyValidation.keyId, {
          model: body.model || "claude-sonnet-4-20250514", // Extract model from request, fallback to Sonnet
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

    // 10. Return Claude's response with quota headers
    const creditsRemaining = PLAN_LIMITS[planType].creditsPerWindow - quotaCheck.usage.currentCredits;

    return new Response(JSON.stringify(responseData), {
      status: claudeResponse.status,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": PLAN_LIMITS[planType].creditsPerWindow.toString(),
        "X-RateLimit-Remaining": Math.max(0, creditsRemaining).toString(),
        "X-RateLimit-Reset": quotaCheck.resetTime.toISOString(),
        "X-Quota-Percentage": quotaCheck.percentages.maxPercentage.toFixed(2)
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
