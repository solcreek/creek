import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./types.js";
import type { AuthUser } from "./modules/tenant/types.js";
import { createAuth, tenantMiddleware } from "./modules/tenant/index.js";
import { auditContextMiddleware } from "./modules/audit/middleware.js";
import { purgeAuditIpLogs } from "./modules/audit/service.js";
import { projects } from "./modules/projects/routes.js";
import { deployments } from "./modules/deployments/routes.js";
import { domains } from "./modules/domains/routes.js";
import { logs } from "./modules/logs/routes.js";
import { metrics } from "./modules/metrics/routes.js";
import { envVars } from "./modules/env/routes.js";
import { instantDeploy } from "./modules/deployments/instant-deploy.js";
import { githubRoutes, verifyWebhookSignature, parseWebhookHeaders, handleInstallation, handlePush, handlePullRequest, handleRepository } from "./modules/github/index.js";
import { webDeploy } from "./modules/web-deploy/routes.js";

import type { AuditRequestContext } from "./modules/audit/types.js";

type AppEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; teamId: string; teamSlug: string; auditCtx: AuditRequestContext };
};

const app = new Hono<AppEnv>();

app.use("*", cors({
  origin: (origin) => {
    // Allow localhost dev + production domains
    if (!origin) return origin;
    if (origin.startsWith("http://localhost:")) return origin;
    if (origin === "https://creek.dev" || origin.endsWith(".creek.dev")) return origin;
    return null;
  },
  allowHeaders: ["Content-Type", "Authorization", "x-creek-team"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
  maxAge: 600,
}));
app.use("*", logger());

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Better Auth routes (signup, login, OAuth callbacks, session, API key management)
app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  try {
    const auth = createAuth(c.env);
    return await auth.handler(c.req.raw);
  } catch (err) {
    console.error("Better Auth error:", err instanceof Error ? err.stack : err);
    return c.json({ error: "auth_error", message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, 500);
  }
});

// GitHub webhook endpoint (UNAUTHENTICATED — GitHub sends these, verified via HMAC)
app.post("/webhooks/github", async (c) => {
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error("GITHUB_WEBHOOK_SECRET not configured");
    return c.json({ error: "not_configured", message: "GitHub webhook secret not configured" }, 503);
  }

  const body = await c.req.text();
  const { event, signature } = parseWebhookHeaders(c.req.raw.headers);

  const valid = await verifyWebhookSignature(body, signature, secret);
  if (!valid) {
    return c.json({ error: "unauthorized", message: "Invalid webhook signature" }, 401);
  }

  const payload = JSON.parse(body);

  // Return 200 immediately, process in background
  c.executionCtx.waitUntil((async () => {
    try {
      switch (event) {
        case "push":
          await handlePush(c.env, payload);
          break;
        case "pull_request":
          await handlePullRequest(c.env, payload);
          break;
        case "installation":
        case "installation_repositories":
          await handleInstallation(c.env, payload);
          break;
        case "repository":
          await handleRepository(c.env, payload);
          break;
      }
    } catch (err) {
      console.error(`Webhook ${event} error:`, err);
    }
  })());

  return c.json({ ok: true, event });
});

// Public routes — no auth required
app.route("/web-deploy", webDeploy);

// Protected routes — tenant middleware resolves user + team, audit captures request context
app.use("/projects/*", tenantMiddleware);
app.use("/projects/*", auditContextMiddleware);
app.use("/instant-deploy/*", tenantMiddleware);
app.use("/instant-deploy/*", auditContextMiddleware);
app.use("/github/*", tenantMiddleware);
app.route("/projects", projects);
app.route("/projects", deployments);
app.route("/projects", domains);
app.route("/projects", envVars);
app.route("/projects", logs);
app.route("/projects", metrics);
app.route("/instant-deploy", instantDeploy);
app.route("/github", githubRoutes);

// Local dev: simulate dispatch worker for testing (GET /preview/:slug/*)
app.get("/preview/:slug/*", async (c) => {
  const slug = c.req.param("slug");
  const project = await c.env.DB.prepare(
    "SELECT id, productionDeploymentId FROM project WHERE slug = ?",
  )
    .bind(slug)
    .first<{ id: string; productionDeploymentId: string | null }>();

  if (!project?.productionDeploymentId) {
    return c.text("Project not found or no production deployment", 404);
  }

  const prefix = `${project.id}/${project.productionDeploymentId}`;
  const reqPath = c.req.path.replace(`/preview/${slug}`, "") || "/index.html";
  const assetPath = reqPath === "/" ? "/index.html" : reqPath;

  const object = await c.env.ASSETS.get(`${prefix}${assetPath}`);
  if (object) {
    const ext = assetPath.split(".").pop()?.toLowerCase() ?? "";
    const types: Record<string, string> = {
      html: "text/html; charset=utf-8",
      css: "text/css; charset=utf-8",
      js: "application/javascript; charset=utf-8",
      json: "application/json; charset=utf-8",
      png: "image/png", svg: "image/svg+xml", ico: "image/x-icon",
    };
    return new Response(object.body as ReadableStream, {
      headers: { "Content-Type": types[ext] || "application/octet-stream" },
    });
  }

  // SPA fallback
  const fallback = await c.env.ASSETS.get(`${prefix}/index.html`);
  if (fallback) {
    return new Response(fallback.body as ReadableStream, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return c.text("Not Found", 404);
});

// Export Hono app for testing
export { app };

// --- Scheduled jobs (cron trigger) ---

async function sweepStaleDeployments(db: D1Database): Promise<number> {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const result = await db.prepare(
    `UPDATE deployment
     SET status = 'failed',
         failedStep = status,
         errorMessage = 'Deploy timed out',
         updatedAt = ?
     WHERE status IN ('uploading', 'provisioning', 'deploying')
       AND updatedAt < ?`,
  ).bind(Date.now(), fiveMinutesAgo).run();
  return result.meta.changes ?? 0;
}

async function processResourceCleanupQueue(env: Env): Promise<number> {
  const pending = await env.DB.prepare(
    `SELECT id, resourceType, cfResourceId, cfResourceName
     FROM resource_cleanup_queue
     WHERE status = 'pending'
     LIMIT 10`,
  ).all<{
    id: number;
    resourceType: string;
    cfResourceId: string;
    cfResourceName: string;
  }>();

  let cleaned = 0;

  for (const row of pending.results) {
    await env.DB.prepare(
      "UPDATE resource_cleanup_queue SET status = 'cleaning' WHERE id = ?",
    ).bind(row.id).run();

    try {
      const accountPath = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
      const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };

      switch (row.resourceType) {
        case "d1":
          await fetch(
            `https://api.cloudflare.com/client/v4${accountPath}/d1/database/${row.cfResourceId}`,
            { method: "DELETE", headers },
          );
          break;
        case "r2":
          await fetch(
            `https://api.cloudflare.com/client/v4${accountPath}/r2/buckets/${row.cfResourceName}`,
            { method: "DELETE", headers },
          );
          break;
        case "kv":
          await fetch(
            `https://api.cloudflare.com/client/v4${accountPath}/storage/kv/namespaces/${row.cfResourceId}`,
            { method: "DELETE", headers },
          );
          break;
        case "custom_hostname":
          if (env.CLOUDFLARE_ZONE_ID) {
            await fetch(
              `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames/${row.cfResourceId}`,
              { method: "DELETE", headers },
            );
          }
          break;
      }

      await env.DB.prepare(
        "UPDATE resource_cleanup_queue SET status = 'done' WHERE id = ?",
      ).bind(row.id).run();
      cleaned++;
    } catch {
      await env.DB.prepare(
        "UPDATE resource_cleanup_queue SET status = 'failed' WHERE id = ?",
      ).bind(row.id).run();
    }
  }

  return cleaned;
}

async function syncPendingDomains(env: Env): Promise<number> {
  if (!env.CLOUDFLARE_ZONE_ID) return 0;

  const pending = await env.DB.prepare(
    `SELECT id, cfCustomHostnameId FROM custom_domain
     WHERE status IN ('pending', 'provisioning')
       AND cfCustomHostnameId IS NOT NULL
     LIMIT 20`,
  ).all<{ id: string; cfCustomHostnameId: string }>();

  let activated = 0;
  const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };

  for (const row of pending.results) {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames/${row.cfCustomHostnameId}`,
        { headers },
      );
      const data = (await res.json()) as any;
      if (!data.success) continue;

      const cfStatus = data.result.status;
      if (cfStatus === "active") {
        await env.DB.prepare(
          "UPDATE custom_domain SET status = 'active' WHERE id = ?",
        ).bind(row.id).run();
        activated++;
      } else if (cfStatus === "deleted" || cfStatus === "pending_deletion") {
        await env.DB.prepare(
          "UPDATE custom_domain SET status = 'failed' WHERE id = ?",
        ).bind(row.id).run();
      }
    } catch {
      // Skip on failure — will retry next cron cycle
    }
  }

  return activated;
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      Promise.all([
        sweepStaleDeployments(env.DB),
        processResourceCleanupQueue(env),
        syncPendingDomains(env),
        purgeAuditIpLogs(env.DB),
      ]),
    );
  },
};
