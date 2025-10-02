import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { registerUser, loginUser, verifyToken } from "./auth";
import { generateAuthUrl, exchangeCode, saveOAuthTokens, hasOAuthConnection, disconnectOAuth } from "./oauth";
import { generateApiKey, listApiKeys, deleteApiKey } from "./keys";
import { proxyToClaudeAPI } from "./proxy";

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
  const keys = listApiKeys(user.userId);

  return c.json({
    keys: keys.map((k) => ({
      id: k.id,
      prefix: k.key_prefix,
      name: k.name,
      is_active: k.is_active === 1,
      created_at: k.created_at,
    })),
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
