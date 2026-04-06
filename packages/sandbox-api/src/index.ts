import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./types.js";
import { routes } from "./routes.js";
import { challengeRoutes } from "./agent-challenge.js";
import { cleanupExpiredSandboxes } from "./cleanup.js";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({
  origin: "*", // Sandbox API is public
  allowHeaders: ["Content-Type", "Authorization", "X-Creek-TTY", "X-Internal-Secret", "X-Forwarded-For"],
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  maxAge: 600,
}));
app.use("*", logger());

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Sandbox routes
app.route("/api/sandbox", routes);

// Agent challenge routes
app.route("/api/sandbox/agent-verify", challengeRoutes);

// Consistent JSON errors for unmatched routes
app.notFound((c) =>
  c.json({ error: "not_found", message: `Route not found: ${c.req.method} ${c.req.path}` }, 404),
);
app.onError((err, c) =>
  c.json({ error: "internal", message: err.message }, 500),
);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanupExpiredSandboxes(env));
  },
};
