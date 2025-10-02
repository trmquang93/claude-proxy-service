import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { registerUser, loginUser, verifyToken } from "./auth";
import { generateAuthUrl, exchangeCode, saveOAuthTokens, hasOAuthConnection, disconnectOAuth } from "./oauth";
import { generateApiKey, listApiKeys, deleteApiKey, assignKey, acceptInvitation, getPendingInvitations, listAllUserKeys } from "./keys";
import { proxyToClaudeAPI } from "./proxy";
import { getKeyUsage, getAggregateUsage } from "./usage";
import db from "./db";

const app = new Hono();

// Enable CORS
app.use("/*", cors({
  origin: process.env.NODE_ENV === "production"
    ? [/railway\.app$/, /claude-proxy-service\.up\.railway\.app$/]
    : "*",
  credentials: true,
}));

// Serve static files
app.use("/public/*", serveStatic({ root: "./" }));
app.use("/", serveStatic({ path: "./public/index.html" }));
app.use("/dashboard", serveStatic({ path: "./public/dashboard.html" }));

// Middleware to verify JWT
const authMiddleware = async (c: any, next: any) => {
  const authHeader = c.req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = authHeader.replace("Bearer ", "");
  const payload = verifyToken(token);

  if (!payload) {
    return c.json({ error: "Invalid token" }, 401);
  }

  c.set("user", payload);
  await next();
};

// Auth endpoints
app.post("/api/auth/register", async (c) => {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400);
  }

  const result = await registerUser(email, password);
  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({ message: "User registered successfully" });
});

app.post("/api/auth/login", async (c) => {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400);
  }

  const result = await loginUser(email, password);
  if (!result.success) {
    return c.json({ error: result.error }, 401);
  }

  return c.json({ token: result.token });
});

// Claude OAuth endpoints
app.get("/api/claude/connect", authMiddleware, async (c) => {
  const user = c.get("user");
  const { url, verifier } = await generateAuthUrl();

  return c.json({ url, verifier });
});

app.post("/api/claude/callback", authMiddleware, async (c) => {
  const user = c.get("user");
  const { code, verifier } = await c.req.json();

  if (!code || !verifier) {
    return c.json({ error: "Code and verifier required" }, 400);
  }

  const result = await exchangeCode(code, verifier);
  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  saveOAuthTokens(user.userId, result.tokens);

  return c.json({ message: "Claude account connected successfully" });
});

app.get("/api/claude/status", authMiddleware, async (c) => {
  const user = c.get("user");
  const connected = hasOAuthConnection(user.userId);

  return c.json({ connected });
});

app.delete("/api/claude/disconnect", authMiddleware, async (c) => {
  const user = c.get("user");
  disconnectOAuth(user.userId);

  return c.json({ message: "Claude account disconnected" });
});

// API Key endpoints
app.post("/api/keys/generate", authMiddleware, async (c) => {
  const user = c.get("user");
  const { name } = await c.req.json().catch(() => ({}));

  // Check if user has connected Claude OAuth
  if (!hasOAuthConnection(user.userId)) {
    return c.json({ error: "Please connect your Claude account first" }, 400);
  }

  const result = await generateApiKey(user.userId, name);
  if (!result.success) {
    return c.json({ error: result.error }, 500);
  }

  return c.json({ key: result.key, prefix: result.prefix });
});

app.get("/api/keys/list", authMiddleware, async (c) => {
  const user = c.get("user");
  const { owned, assigned } = listAllUserKeys(user.userId);

  // Get user email for pending invitations
  const currentUser = db.query("SELECT email FROM users WHERE id = ?").get(user.userId) as { email: string } | undefined;
  const pendingInvitations = currentUser ? getPendingInvitations(currentUser.email) : [];

  // Format owned keys with usage and assignment info
  const formattedOwned = owned.map((k) => {
    const usage = getKeyUsage(k.id);
    let assignedToEmail = null;
    let assignmentStatus = k.assignment_status;

    if (k.assigned_to_email) {
      assignedToEmail = k.assigned_to_email;
    }

    return {
      id: k.id,
      prefix: k.key_prefix,
      name: k.name,
      is_active: k.is_active === 1,
      created_at: k.created_at,
      assigned_to_email: assignedToEmail,
      assignment_status: assignmentStatus,
      usage: usage || {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 0,
        total_cost: 0,
        request_count: 0,
      },
    };
  });

  // Format assigned keys with owner info and usage
  const formattedAssigned = assigned.map((k) => {
    const usage = getKeyUsage(k.id);
    const owner = db.query("SELECT email FROM users WHERE id = ?").get(k.user_id) as { email: string } | undefined;

    return {
      id: k.id,
      prefix: k.key_prefix,
      name: k.name || `${owner?.email || 'Unknown'}'s key`,
      is_active: k.is_active === 1,
      created_at: k.created_at,
      owner_email: owner?.email || 'Unknown',
      usage: usage || {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 0,
        total_cost: 0,
        request_count: 0,
      },
    };
  });

  // Format pending invitations
  const formattedPending = pendingInvitations.map((k) => {
    const owner = db.query("SELECT email FROM users WHERE id = ?").get(k.user_id) as { email: string } | undefined;

    return {
      id: k.id,
      invitation_token: k.invitation_token,
      owner_email: owner?.email || 'Unknown',
      created_at: k.created_at,
    };
  });

  // Calculate aggregate usage for owned keys
  const ownedKeyIds = owned.map(k => k.id);
  const aggregateUsage = ownedKeyIds.length > 0 ? getAggregateUsage(ownedKeyIds) : {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    total_cost: 0,
    request_count: 0,
  };

  return c.json({
    owned: formattedOwned,
    assigned: formattedAssigned,
    pending_invitations: formattedPending,
    aggregate_usage: aggregateUsage,
  });
});

app.delete("/api/keys/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const keyId = c.req.param("id");

  const success = deleteApiKey(keyId, user.userId);
  if (!success) {
    return c.json({ error: "Failed to delete API key" }, 400);
  }

  return c.json({ message: "API key deleted successfully" });
});

// Assign API key to user by email
app.post("/api/keys/:id/assign", authMiddleware, async (c) => {
  const user = c.get("user");
  const keyId = c.req.param("id");
  const { email } = await c.req.json();

  if (!email) {
    return c.json({ error: "Email is required" }, 400);
  }

  const result = await assignKey(keyId, user.userId, email);
  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({ message: "Key assigned successfully. Invitation sent to " + email });
});

// Accept invitation
app.post("/api/keys/accept-invitation/:token", authMiddleware, async (c) => {
  const user = c.get("user");
  const token = c.req.param("token");

  const result = await acceptInvitation(token, user.userId);
  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({ message: "Invitation accepted successfully" });
});

// Get specific key usage
app.get("/api/keys/:id/usage", authMiddleware, async (c) => {
  const user = c.get("user");
  const keyId = c.req.param("id");

  // Verify user has access to this key (either owner or assigned user)
  const key = db.query(`
    SELECT * FROM api_keys
    WHERE id = ?
    AND (user_id = ? OR assigned_to_user_id = ?)
    AND is_active = 1
  `).get(keyId, user.userId, user.userId);

  if (!key) {
    return c.json({ error: "Key not found or access denied" }, 404);
  }

  const usage = getKeyUsage(keyId);
  return c.json({ usage: usage || {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    total_cost: 0,
    request_count: 0,
  }});
});

// Proxy endpoint (public - uses API key)
app.post("/v1/messages", async (c) => {
  return proxyToClaudeAPI(c.req.raw);
});

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

const port = parseInt(process.env.PORT || "3000");

console.log(`Server running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
