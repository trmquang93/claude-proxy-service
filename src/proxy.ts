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
              usage_percentage: quotaCheck.percentages.creditPercentage,
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
        "X-Quota-Percentage": quotaCheck.percentages.creditPercentage.toFixed(2)
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

// Generic proxy for any Claude API endpoint
export async function proxyToClaudeAPIGeneric(request: Request, path: string, method: string): Promise<Response> {
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

    // 4. Get plan type and check quota (for /v1/messages only)
    const userResult = await pool.query(
      "SELECT plan_type FROM users WHERE id = $1",
      [keyValidation.userId]
    );
    const planType = userResult.rows[0]?.plan_type || 'pro';

    let quotaCheck = null;
    if (path === '/v1/messages') {
      quotaCheck = await checkQuotaLimit(keyValidation.keyId, planType);

      if (!quotaCheck.allowed) {
        return new Response(
          JSON.stringify({
            error: {
              type: "rate_limit_error",
              message: quotaCheck.reason,
              quota_exceeded: {
                usage_percentage: quotaCheck.percentages.creditPercentage,
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
    }

    // 5. Get valid OAuth access token
    const tokenResult = await ensureValidToken(keyValidation.userId);
    if (!tokenResult.success || !tokenResult.accessToken) {
      return new Response(
        JSON.stringify({ error: "OAuth token not found or expired. Please reconnect Claude account." }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 6. Prepare request body (if present)
    let body = null;
    let requestBody = null;

    if (method !== 'GET' && method !== 'HEAD') {
      const contentType = request.headers.get("content-type");

      if (contentType?.includes("application/json")) {
        try {
          body = await request.json();
          requestBody = JSON.stringify(body);
        } catch (error) {
          console.error("Failed to parse JSON body:", error);
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
      } else if (contentType) {
        // For non-JSON content types, read as text/blob
        requestBody = await request.text();
      }
    }

    // 7. Build headers for Claude API
    const claudeHeaders: Record<string, string> = {
      "authorization": `Bearer ${tokenResult.accessToken}`,
      "anthropic-version": "2023-06-01",
    };

    // Preserve important client headers
    const preserveHeaders = [
      "content-type",
      "anthropic-beta",
      "anthropic-dangerous-direct-browser-access"
    ];

    for (const headerName of preserveHeaders) {
      const headerValue = request.headers.get(headerName);
      if (headerValue) {
        claudeHeaders[headerName] = headerValue;
      }
    }

    // Add default anthropic-beta if not present
    if (!claudeHeaders["anthropic-beta"]) {
      claudeHeaders["anthropic-beta"] = "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";
    }

    // 8. Forward to Claude API
    const claudeUrl = `https://api.anthropic.com${path}`;
    console.log(`[Proxy] Forwarding ${method} ${path} to Claude API`);

    const claudeResponse = await fetch(claudeUrl, {
      method: method,
      headers: claudeHeaders,
      body: requestBody,
    });

    // 9. Handle streaming vs non-streaming responses
    const responseContentType = claudeResponse.headers.get("content-type") || "";
    const isStreaming = responseContentType.includes("text/event-stream") || responseContentType.includes("stream");

    if (isStreaming) {
      // For streaming responses, pipe through directly
      console.log("[Proxy] Streaming response detected, piping through");

      const headers: Record<string, string> = {};
      claudeResponse.headers.forEach((value, key) => {
        headers[key] = value;
      });

      // Add quota headers for /v1/messages
      if (quotaCheck) {
        const creditsRemaining = PLAN_LIMITS[planType].creditsPerWindow - quotaCheck.usage.currentCredits;
        headers["X-RateLimit-Limit"] = PLAN_LIMITS[planType].creditsPerWindow.toString();
        headers["X-RateLimit-Remaining"] = Math.max(0, creditsRemaining).toString();
        headers["X-RateLimit-Reset"] = quotaCheck.resetTime.toISOString();
        headers["X-Quota-Percentage"] = quotaCheck.percentages.creditPercentage.toFixed(2);
      }

      return new Response(claudeResponse.body, {
        status: claudeResponse.status,
        headers: headers,
      });
    }

    // 10. For non-streaming responses, parse JSON
    const responseData = await claudeResponse.json();

    // 11. Track usage if response is successful and contains usage data (only for /v1/messages)
    if (path === '/v1/messages' && claudeResponse.ok && responseData.usage) {
      try {
        await updateKeyUsage(keyValidation.keyId, {
          model: body?.model || "claude-sonnet-4-20250514",
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

    // 12. Return response with quota headers (for /v1/messages)
    const responseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (quotaCheck) {
      const creditsRemaining = PLAN_LIMITS[planType].creditsPerWindow - quotaCheck.usage.currentCredits;
      responseHeaders["X-RateLimit-Limit"] = PLAN_LIMITS[planType].creditsPerWindow.toString();
      responseHeaders["X-RateLimit-Remaining"] = Math.max(0, creditsRemaining).toString();
      responseHeaders["X-RateLimit-Reset"] = quotaCheck.resetTime.toISOString();
      responseHeaders["X-Quota-Percentage"] = quotaCheck.percentages.creditPercentage.toFixed(2);
    }

    return new Response(JSON.stringify(responseData), {
      status: claudeResponse.status,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error(`[Proxy Error] ${method} ${path}:`, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      type: error?.constructor?.name
    });

    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error)
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
