import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./types.js";
import { processResourceCleanupQueue } from "./modules/resources/cleanup-queue.js";
import type { AuthUser } from "./modules/tenant/types.js";
import {
  createAuth,
  tenantMiddleware,
  originGuard,
  isAllowedOrigin,
} from "./modules/tenant/index.js";
import { auditContextMiddleware } from "./modules/audit/middleware.js";
import { purgeAuditIpLogs } from "./modules/audit/service.js";
import { projects } from "./modules/projects/routes.js";
import { deployments } from "./modules/deployments/routes.js";
import { deleteStagedBundle, consumeDeployJobBatch } from "./modules/deployments/deploy-job.js";
import { domains } from "./modules/domains/routes.js";
import { linkUnregisteredDomains } from "./modules/domains/edge.js";
import { logs } from "./modules/logs/routes.js";
import { metrics } from "./modules/metrics/routes.js";
import { envVars } from "./modules/env/routes.js";
import { instantDeploy } from "./modules/deployments/instant-deploy.js";
import {
  githubRoutes,
  verifyWebhookSignature,
  parseWebhookHeaders,
  handleInstallation,
  handlePush,
  handlePullRequest,
  handleRepository,
} from "./modules/github/index.js";
import { webDeploy } from "./modules/web-deploy/routes.js";
import { buildLogs, buildLogsRead } from "./modules/build-logs/routes.js";
import { purgeExpiredBuildLogs } from "./modules/build-logs/purge.js";
import { resources, resourceBindings } from "./modules/resources/routes.js";
import { aggregateYesterday } from "./modules/metering/aggregate.js";

import type { AuditRequestContext } from "./modules/audit/types.js";
import {
  apiKeyAuthRouteGuard,
  apiKeyRouteGate,
  publicRoute,
} from "./modules/tenant/scope-guard.js";

type AppEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; teamId: string; teamSlug: string; auditCtx: AuditRequestContext };
};

const app = new Hono<AppEnv>();

app.use(
  "*",
  cors({
    origin: (origin) => {
      // Single source of truth with originGuard: localhost dev + https
      // creek.dev origins only. Non-https *.creek.dev is rejected here too.
      if (!origin) return origin;
      return isAllowedOrigin(origin) ? origin : null;
    },
    allowHeaders: ["Content-Type", "Authorization", "x-creek-team"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    maxAge: 600,
  }),
);
app.use("*", logger());

// CSRF defense-in-depth: reject state-changing requests that carry a foreign
// Origin. Runs after cors() (so the OPTIONS preflight is still answered) and
// before any route. Non-browser callers (CLI, CI, GitHub webhooks, internal
// service-to-service) omit Origin and pass through; see origin-guard.ts.
app.use("*", originGuard);

// API key requests must hit a route that declares what a key needs (see
// tenant/scope-guard.ts); anything else is refused before it runs.
app.use("*", apiKeyRouteGate);

// Health check
app.get("/health", publicRoute, (c) => c.json({ status: "ok" }));

// Better Auth routes (signup, login, OAuth callbacks, session, API key management)
app.on(["POST", "GET"], "/api/auth/*", apiKeyAuthRouteGuard, async (c) => {
  try {
    const auth = createAuth(c.env);
    return await auth.handler(c.req.raw);
  } catch (err) {
    console.error("Better Auth error:", err instanceof Error ? err.stack : err);
    return c.json(
      {
        error: "auth_error",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      500,
    );
  }
});

// GitHub webhook endpoint (UNAUTHENTICATED — GitHub sends these, verified via HMAC)
app.post("/webhooks/github", publicRoute, async (c) => {
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error("GITHUB_WEBHOOK_SECRET not configured");
    return c.json(
      { error: "not_configured", message: "GitHub webhook secret not configured" },
      503,
    );
  }

  const body = await c.req.text();
  const { event, signature } = parseWebhookHeaders(c.req.raw.headers);

  const valid = await verifyWebhookSignature(body, signature, secret);
  if (!valid) {
    return c.json({ error: "unauthorized", message: "Invalid webhook signature" }, 401);
  }

  const payload = JSON.parse(body);

  // Return 200 immediately, process in background
  c.executionCtx.waitUntil(
    (async () => {
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
    })(),
  );

  return c.json({ ok: true, event });
});

// Public routes — no auth required
app.route("/web-deploy", webDeploy);

// Build log ingest — its own auth inside (INTERNAL_SECRET for internal
// callers, tenantMiddleware for CLI). Not nested under /projects because
// the deploymentId alone identifies the log; callers don't always know
// the project slug at the time they POST.
app.route("/builds", buildLogs);

// Protected routes — tenant middleware resolves user + team, audit captures request context
app.use("/projects/*", tenantMiddleware);
app.use("/projects/*", auditContextMiddleware);
app.use("/instant-deploy/*", tenantMiddleware);
app.use("/instant-deploy/*", auditContextMiddleware);
app.use("/github/*", tenantMiddleware);
// Resources: team-scoped resource CRUD. Needs tenantMiddleware the
// same way /projects does. Separate mount point keeps the semantic clean
// — these are team-level entities, not project children.
app.use("/resources/*", tenantMiddleware);
app.route("/projects", projects);
app.route("/projects", deployments);
app.route("/projects", domains);
app.route("/projects", envVars);
app.route("/projects", logs);
app.route("/projects", metrics);
app.route("/projects", buildLogsRead);
app.route("/projects", resourceBindings);
app.route("/resources", resources);
app.route("/instant-deploy", instantDeploy);
app.route("/github", githubRoutes);

// GET /preview/:slug/* (local dispatch stand-in) is mounted by src/local/serve.ts only.

// Export Hono app for testing
export { app };

// --- Scheduled jobs (cron trigger) ---

// A deploy job beats updatedAt every ~60s while it's actively progressing
// (see withDeployHeartbeat in deploy-job.ts). So a deployment whose updatedAt
// has gone quiet for this long is genuinely stuck — its waitUntil context died
// — not merely slow. Kept comfortably above the heartbeat interval so a few
// missed beats (event-loop saturation during a large upload) don't false-kill
// a live deploy.
const STALE_DEPLOY_MS = 10 * 60 * 1000;

async function sweepStaleDeployments(env: Env): Promise<number> {
  const staleBefore = Date.now() - STALE_DEPLOY_MS;
  // Record a per-stage, actionable reason rather than a bare "Deploy timed
  // out" — the read-side fallback (build-logs) classifies these into stable
  // reason codes, and "deploy window" is the phrase that classifier keys off.
  // RETURNING gives us exactly the rows we just failed (no SELECT-then-UPDATE
  // race) so we can reclaim their R2 staging below.
  const result = await env.DB.prepare(
    `UPDATE deployment
     SET status = 'failed',
         failedStep = status,
         errorMessage = CASE status
           WHEN 'uploading' THEN 'Upload exceeded the 10-minute deploy window — usually bundle size or a slow link. Shrink the bundle, then retry.'
           WHEN 'provisioning' THEN 'Provisioning exceeded the 10-minute deploy window — a backing resource (D1/R2/KV) did not come up; retry, and check the resource if it persists.'
           WHEN 'deploying' THEN 'Activation exceeded the 10-minute deploy window — most often the asset count/size. Reduce assets or split the deploy, then retry.'
           ELSE 'Deploy timed out'
         END,
         updatedAt = ?
     WHERE status IN ('uploading', 'provisioning', 'deploying')
       AND updatedAt < ?
     RETURNING id`,
  )
    .bind(Date.now(), staleBefore)
    .all<{ id: string }>();

  const ids = result.results ?? [];
  // A deploy killed mid-flight (e.g. OOM) never runs its own cleanup; the reaper
  // is the only thing that touches it afterwards, so reclaim its staging here.
  for (const { id } of ids) {
    await deleteStagedBundle(env, id);
  }
  return ids.length;
}

async function syncPendingDomains(env: Env): Promise<number> {
  if (!env.CLOUDFLARE_ZONE_ID) return 0;

  // Rows whose CF call failed at add time have no edge id, so the status poll
  // below can't see them. Register them first.
  await linkUnregisteredDomains(env).catch((err) =>
    console.error("[domains] linking unregistered domains failed:", err),
  );

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
        await env.DB.prepare("UPDATE custom_domain SET status = 'active' WHERE id = ?")
          .bind(row.id)
          .run();
        activated++;
      } else if (cfStatus === "deleted" || cfStatus === "pending_deletion") {
        await env.DB.prepare("UPDATE custom_domain SET status = 'failed' WHERE id = ?")
          .bind(row.id)
          .run();
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
        sweepStaleDeployments(env),
        processResourceCleanupQueue(env),
        syncPendingDomains(env),
        purgeAuditIpLogs(env.DB),
        purgeExpiredBuildLogs(env),
        aggregateUsageSafe(env),
      ]),
    );
  },
  // Deploy jobs run here (creek-deploy-jobs), not in the bundle-upload
  // request's waitUntil — workerd cancels waitUntil ~30s after the response,
  // which killed large-worker activations. See consumeDeployJobBatch.
  async queue(batch: MessageBatch, env: Env) {
    await consumeDeployJobBatch(batch, env);
  },
};

/**
 * Wrap the metering aggregator so a transient AE / D1 failure on one
 * cron tick doesn't kill the rest of the scheduled handler. Idempotent
 * upsert means the next tick can catch up without double-counting, and
 * a structural failure surfaces in Workers traces rather than silently
 * dropping the daily rollup.
 */
async function aggregateUsageSafe(env: Env): Promise<void> {
  try {
    await aggregateYesterday(env);
  } catch (err) {
    console.error("metering.aggregateYesterday failed:", err);
  }
}
