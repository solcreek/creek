import { Hono } from "hono";
import type { Env, AuthUser } from "../../types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { shortDeployId } from "./deploy.js";
import { runDeployJob } from "./deploy-job.js";
import { requirePermission } from "../tenant/permissions.js";
import { recordAudit } from "../audit/service.js";

type DeployEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; teamId: string; teamSlug: string; memberRole?: string; auditCtx: AuditRequestContext };
};

const deployments = new Hono<DeployEnv>();

// Create a new deployment
deployments.post("/:projectId/deployments", requirePermission("deploy:create"), async (c) => {
  const teamId = c.get("teamId");
  const projectId = c.req.param("projectId");

  const project = await c.env.DB.prepare(
    "SELECT * FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{ id: string; slug: string }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const body = await c.req.json<{
    branch?: string;
    commitSha?: string;
    commitMessage?: string;
    triggerType?: string;
  }>().catch((): { branch?: string; commitSha?: string; commitMessage?: string; triggerType?: string } => ({}));

  const lastDeployment = await c.env.DB.prepare(
    "SELECT MAX(version) as max_version FROM deployment WHERE projectId = ?",
  )
    .bind(project.id)
    .first<{ max_version: number | null }>();

  const version = (lastDeployment?.max_version ?? 0) + 1;
  const id = crypto.randomUUID();

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO deployment (id, projectId, version, status, branch, commitSha, commitMessage, triggerType, createdAt, updatedAt)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      project.id,
      version,
      body.branch ?? null,
      body.commitSha ?? null,
      body.commitMessage ?? null,
      body.triggerType ?? "cli",
      now,
      now,
    )
    .run();

  const deployment = await c.env.DB.prepare("SELECT * FROM deployment WHERE id = ?")
    .bind(id)
    .first();

  await recordAudit(c.env.DB, c.get("user"), c.get("teamId"), {
    action: "deployment.create",
    resourceType: "deployment",
    resourceId: id,
    metadata: { projectId: project.id, version },
  }, c.get("auditCtx"));

  // --- Build cache check (⚡ Turbo deploy) ---
  // If the CLI sent a commitSha, check if the remote-builder's
  // KV cache has a pre-built bundle for this exact commit. If so,
  // kick off a deploy from cache asynchronously — the CLI sees
  // cacheHit=true and skips its local build + upload entirely.
  let cacheHit = false;
  if (body.commitSha && c.env.BUILD_STATUS) {
    try {
      // Try multiple cache key patterns (with and without branch)
      const repoUrl = await getProjectRepoUrl(c.env.DB, project.id);
      if (repoUrl) {
        const branch = body.branch || "main";
        const cacheKey = `bundlecache:${repoUrl}:${branch}:${body.commitSha}`;
        const cached = await c.env.BUILD_STATUS.get(cacheKey);
        if (cached) {
          cacheHit = true;
          console.log(`[turbo-deploy] HIT ${cacheKey.slice(0, 80)} for deployment ${id}`);
          // Deploy from cache asynchronously — same path as PUT /bundle
          // but using the cached bundle instead of CLI upload
          c.executionCtx.waitUntil(
            deployFromBundleCache(c.env, project, {
              id,
              teamId,
              teamSlug: c.get("teamSlug"),
              branch: body.branch,
              commitSha: body.commitSha,
            }, cached),
          );
        } else {
          console.log(`[turbo-deploy] MISS ${cacheKey.slice(0, 80)}`);
        }
      }
    } catch (err) {
      console.error("[turbo-deploy] cache check error:", err);
      // Fall through — CLI will build + upload normally
    }
  }

  return c.json({ deployment, cacheHit }, 201);
});

// Upload deployment bundle (async — returns 202, deploy runs via waitUntil)
deployments.put("/:projectId/deployments/:deploymentId/bundle", async (c) => {
  const teamId = c.get("teamId");
  const teamSlug = c.get("teamSlug");
  const projectId = c.req.param("projectId");
  const deploymentId = c.req.param("deploymentId");

  const project = await c.env.DB.prepare(
    "SELECT * FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{
      id: string;
      slug: string;
      framework: string | null;
      productionBranch: string;
    }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const deployment = await c.env.DB.prepare(
    "SELECT * FROM deployment WHERE id = ? AND projectId = ?",
  )
    .bind(deploymentId, project.id)
    .first<{ id: string; status: string; branch: string | null }>();

  if (!deployment) {
    return c.json({ error: "not_found", message: "Deployment not found" }, 404);
  }

  // Idempotency guards
  const IN_PROGRESS = new Set(["uploading", "provisioning", "deploying"]);
  if (IN_PROGRESS.has(deployment.status)) {
    return c.json(
      { error: "conflict", message: "Deployment is already in progress" },
      409,
    );
  }
  if (deployment.status === "active") {
    return c.json(
      { error: "invalid_state", message: "Deployment already completed. Create a new deployment to redeploy." },
      400,
    );
  }
  if (deployment.status !== "queued" && deployment.status !== "failed") {
    return c.json(
      { error: "invalid_state", message: `Cannot upload bundle in '${deployment.status}' state` },
      400,
    );
  }

  try {
    // --- Bundle guardrails ---
    const bundleBody = await c.req.text();

    const MAX_BUNDLE_SIZE = 50 * 1024 * 1024; // 50MB
    if (bundleBody.length > MAX_BUNDLE_SIZE) {
      return c.json(
        { error: "validation", message: `Bundle too large (${Math.round(bundleBody.length / 1024 / 1024)}MB). Max is 50MB.` },
        400,
      );
    }

    let parsedBundle: {
      manifest?: { assets?: unknown[]; hasWorker?: boolean; entrypoint?: unknown; renderMode?: string };
      assets?: Record<string, unknown>;
      serverFiles?: Record<string, unknown>;
    };
    try {
      parsedBundle = JSON.parse(bundleBody);
    } catch {
      return c.json({ error: "validation", message: "Invalid JSON in bundle body" }, 400);
    }

    if (!parsedBundle.manifest || !Array.isArray(parsedBundle.manifest.assets)) {
      return c.json({ error: "validation", message: "Bundle must include manifest with assets array" }, 400);
    }

    // SSR/Worker bundles may have zero client assets (all rendering is server-side)
    const hasWorker = parsedBundle.manifest?.hasWorker === true;
    const hasServerFiles = parsedBundle.serverFiles && Object.keys(parsedBundle.serverFiles).length > 0;
    if (!hasWorker && (!parsedBundle.assets || Object.keys(parsedBundle.assets).length === 0)) {
      return c.json({ error: "validation", message: "Bundle must include at least one asset" }, 400);
    }

    const MAX_ASSET_COUNT = 10_000;
    const assetCount = Object.keys(parsedBundle.assets ?? {}).length;
    if (assetCount > MAX_ASSET_COUNT) {
      return c.json(
        { error: "validation", message: `Too many assets (${assetCount}). Max is ${MAX_ASSET_COUNT}.` },
        400,
      );
    }

    // Stage bundle to R2
    const bundleKey = `bundles/${deploymentId}.json`;
    await c.env.ASSETS.put(bundleKey, bundleBody);

    // Mark as uploading
    await c.env.DB.prepare(
      "UPDATE deployment SET status = 'uploading', failedStep = NULL, errorMessage = NULL, updatedAt = ? WHERE id = ?",
    )
      .bind(Date.now(), deploymentId)
      .run();

    // Get team plan
    const team = await c.env.DB.prepare("SELECT plan FROM organization WHERE id = ?")
      .bind(teamId)
      .first<{ plan: string }>();

    await recordAudit(c.env.DB, c.get("user"), c.get("teamId"), {
      action: "deployment.deploy",
      resourceType: "deployment",
      resourceId: deploymentId,
      metadata: { projectId: project.id, projectSlug: project.slug },
    }, c.get("auditCtx"));

    // Fire async deploy job via waitUntil
    const jobPromise = runDeployJob(c.env, {
      deploymentId,
      projectId: project.id,
      projectSlug: project.slug,
      teamId,
      teamSlug,
      plan: team?.plan ?? "free",
      branch: deployment.branch,
      productionBranch: project.productionBranch,
      framework: project.framework,
    });

    c.executionCtx.waitUntil(jobPromise);

    // Return 202 immediately — CLI polls GET /deployments/:id for progress
    const updatedDeployment = await c.env.DB.prepare("SELECT * FROM deployment WHERE id = ?")
      .bind(deploymentId)
      .first();

    return c.json({ deployment: updatedDeployment }, 202);
  } catch (err) {
    await c.env.DB.prepare(
      `UPDATE deployment SET status = 'failed', failedStep = 'uploading', errorMessage = ?, updatedAt = ? WHERE id = ?`,
    )
      .bind(err instanceof Error ? err.message : "Unknown error", Date.now(), deploymentId)
      .run();

    return c.json(
      { error: "deploy_failed", message: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
});

// Get deployment status
deployments.get("/:projectId/deployments/:deploymentId", async (c) => {
  const teamId = c.get("teamId");
  const teamSlug = c.get("teamSlug");
  const projectId = c.req.param("projectId");
  const deploymentId = c.req.param("deploymentId");

  const project = await c.env.DB.prepare(
    "SELECT * FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{ id: string; slug: string; productionDeploymentId: string | null }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const deployment = await c.env.DB.prepare(
    "SELECT * FROM deployment WHERE id = ? AND projectId = ?",
  )
    .bind(deploymentId, project.id)
    .first();

  if (!deployment) {
    return c.json({ error: "not_found", message: "Deployment not found" }, 404);
  }

  const domain = c.env.CREEK_DOMAIN;
  const shortId = shortDeployId(deploymentId);
  const isProduction = project.productionDeploymentId === deploymentId;

  return c.json({
    deployment,
    url: isProduction
      ? `https://${project.slug}-${teamSlug}.${domain}`
      : null,
    previewUrl: `https://${project.slug}-${shortId}-${teamSlug}.${domain}`,
  });
});

// List deployments for a project
deployments.get("/:projectId/deployments", async (c) => {
  const teamId = c.get("teamId");
  const teamSlug = c.get("teamSlug");
  const projectId = c.req.param("projectId");

  const project = await c.env.DB.prepare(
    "SELECT id, slug, productionDeploymentId FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{ id: string; slug: string; productionDeploymentId: string | null }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const rows = await c.env.DB.prepare(
    "SELECT * FROM deployment WHERE projectId = ? ORDER BY version DESC LIMIT 20",
  )
    .bind(project.id)
    .all<{ id: string; status: string }>();

  // Attach the live URL to each active deployment. Production deployments use
  // the bare `{slug}-{team}.{domain}` host (matches dispatch-worker routing);
  // non-production active deployments use a `{slug}-{shortId}-{team}` host so
  // each historical deployment stays reachable as an immutable preview.
  const domain = c.env.CREEK_DOMAIN;
  const enriched = (rows.results ?? []).map((row) => {
    if (row.status !== "active") return { ...row, url: null };
    const isProduction = row.id === project.productionDeploymentId;
    const url = isProduction
      ? `https://${project.slug}-${teamSlug}.${domain}`
      : `https://${project.slug}-${row.id.slice(0, 8)}-${teamSlug}.${domain}`;
    return { ...row, url };
  });

  return c.json(enriched);
});

// Promote a deployment to production
deployments.post("/:projectId/deployments/:deploymentId/promote", requirePermission("deploy:create"), async (c) => {
  const teamId = c.get("teamId");
  const projectId = c.req.param("projectId");
  const deploymentId = c.req.param("deploymentId");

  const project = await c.env.DB.prepare(
    "SELECT * FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{ id: string; slug: string }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const deployment = await c.env.DB.prepare(
    "SELECT * FROM deployment WHERE id = ? AND projectId = ?",
  )
    .bind(deploymentId, project.id)
    .first<{ id: string; status: string }>();

  if (!deployment) {
    return c.json({ error: "not_found", message: "Deployment not found" }, 404);
  }

  if (deployment.status !== "active") {
    return c.json(
      { error: "invalid_state", message: `Cannot promote deployment in '${deployment.status}' state. Only 'active' deployments can be promoted.` },
      400,
    );
  }

  await c.env.DB.prepare(
    "UPDATE project SET productionDeploymentId = ?, updatedAt = ? WHERE id = ?",
  )
    .bind(deploymentId, Date.now(), project.id)
    .run();

  await recordAudit(c.env.DB, c.get("user"), c.get("teamId"), {
    action: "deployment.promote",
    resourceType: "deployment",
    resourceId: deploymentId,
    metadata: { projectId: project.id },
  }, c.get("auditCtx"));

  return c.json({ ok: true, productionDeploymentId: deploymentId });
});

// Rollback production to a previous deployment
deployments.post("/:projectId/rollback", requirePermission("deploy:create"), async (c) => {
  const teamId = c.get("teamId");
  const teamSlug = c.get("teamSlug");
  const projectId = c.req.param("projectId");
  const body = await c.req.json<{ deploymentId?: string; message?: string }>().catch(() => ({} as { deploymentId?: string; message?: string }));

  const project = await c.env.DB.prepare(
    "SELECT * FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{ id: string; slug: string; productionDeploymentId: string | null }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  if (!project.productionDeploymentId) {
    return c.json({ error: "no_production", message: "No production deployment to rollback from" }, 400);
  }

  // Find target deployment
  let targetId = body.deploymentId;
  if (!targetId) {
    // No ID specified → find previous active production deployment
    const prev = await c.env.DB.prepare(
      `SELECT id FROM deployment WHERE projectId = ? AND status = 'active'
       AND id != ? ORDER BY version DESC LIMIT 1`,
    )
      .bind(project.id, project.productionDeploymentId)
      .first<{ id: string }>();

    if (!prev) {
      return c.json({ error: "no_previous", message: "No previous deployment to rollback to" }, 400);
    }
    targetId = prev.id;
  }

  // Validate target
  const target = await c.env.DB.prepare(
    "SELECT * FROM deployment WHERE id = ? AND projectId = ? AND status = 'active'",
  )
    .bind(targetId, project.id)
    .first<{ id: string; version: number }>();

  if (!target) {
    return c.json({ error: "invalid_target", message: "Target deployment not found or not active" }, 400);
  }

  if (targetId === project.productionDeploymentId) {
    return c.json({ error: "already_production", message: "Already the production deployment" }, 400);
  }

  // Create rollback deployment record + switch production pointer
  const rollbackId = crypto.randomUUID();
  const lastDeploy = await c.env.DB.prepare(
    "SELECT MAX(version) as v FROM deployment WHERE projectId = ?",
  )
    .bind(project.id)
    .first<{ v: number | null }>();
  const version = (lastDeploy?.v ?? 0) + 1;
  const now = Date.now();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO deployment (id, projectId, version, status, triggerType, commitMessage, createdAt, updatedAt)
       VALUES (?, ?, ?, 'active', 'rollback', ?, ?, ?)`,
    ).bind(rollbackId, project.id, version, body.message ?? null, now, now),
    c.env.DB.prepare(
      "UPDATE project SET productionDeploymentId = ?, updatedAt = ? WHERE id = ?",
    ).bind(targetId, now, project.id),
  ]);

  await recordAudit(c.env.DB, c.get("user"), teamId, {
    action: "deployment.rollback",
    resourceType: "deployment",
    resourceId: rollbackId,
    metadata: {
      projectId: project.id,
      targetDeploymentId: targetId,
      previousDeploymentId: project.productionDeploymentId,
      message: body.message,
    },
  }, c.get("auditCtx"));

  const domain = c.env.CREEK_DOMAIN;
  return c.json({
    ok: true,
    deploymentId: rollbackId,
    rolledBackTo: targetId,
    previousDeploymentId: project.productionDeploymentId,
    url: `https://${project.slug}-${teamSlug}.${domain}`,
  });
});

/**
 * GET /projects/:id/cron-logs
 * Query CF Workers analytics for cron invocation history.
 */
deployments.get("/:projectId/cron-logs", async (c) => {
  const teamId = c.get("teamId");
  const teamSlug = c.get("teamSlug");
  const projectId = c.req.param("projectId");

  const project = await c.env.DB.prepare(
    "SELECT slug FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{ slug: string }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  // Production script name follows the convention: {slug}-{teamSlug}
  const scriptName = `${project.slug}-${teamSlug}`;

  // Query CF GraphQL Analytics API for cron invocations (last 24h)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const query = `
    query {
      viewer {
        accounts(filter: { accountTag: "${c.env.CLOUDFLARE_ACCOUNT_ID}" }) {
          workersInvocationsAdaptive(
            filter: {
              scriptName: "${scriptName}"
              datetime_gt: "${since}"
            }
            limit: 50
            orderBy: [datetime_DESC]
          ) {
            dimensions {
              datetime
              status
              scriptName
            }
            sum {
              requests
              errors
              duration
            }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    const data = await res.json() as any;
    const invocations = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

    return c.json({
      scriptName,
      period: "24h",
      invocations: invocations.map((inv: any) => ({
        datetime: inv.dimensions.datetime,
        status: inv.dimensions.status,
        requests: inv.sum.requests,
        errors: inv.sum.errors,
        durationMs: inv.sum.duration,
      })),
    });
  } catch {
    return c.json({ scriptName, period: "24h", invocations: [] });
  }
});

/**
 * GET /projects/:id/analytics?period=24h|7d|30d
 * Per-tenant analytics: requests, errors, latency time-series.
 */
deployments.get("/:projectId/analytics", async (c) => {
  const teamId = c.get("teamId");
  const teamSlug = c.get("teamSlug");
  const projectId = c.req.param("projectId");
  const period = c.req.query("period") ?? "24h";

  const project = await c.env.DB.prepare(
    "SELECT slug FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{ slug: string }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const scriptName = `${project.slug}-${teamSlug}`;

  // Period → hours + grouping
  const periodHours =
    period === "30d" ? 720
    : period === "7d" ? 168
    : period === "6h" ? 6
    : period === "1h" ? 1
    : 24;
  const since = new Date(Date.now() - periodHours * 60 * 60 * 1000).toISOString();

  // Bucket width: ≤1h → 5 min, ≤24h → 15 min, else 1 hour
  const timeDimension =
    periodHours <= 1 ? "datetimeFiveMinutes"
    : periodHours <= 24 ? "datetimeFifteenMinutes"
    : "datetimeHour";

  const query = `
    query {
      viewer {
        accounts(filter: { accountTag: "${c.env.CLOUDFLARE_ACCOUNT_ID}" }) {
          series: workersInvocationsAdaptive(
            filter: {
              scriptName: "${scriptName}"
              datetime_gt: "${since}"
            }
            limit: 1000
            orderBy: [${timeDimension}_ASC]
          ) {
            dimensions {
              ${timeDimension}
              status
            }
            sum {
              requests
              errors
              subrequests
            }
            quantiles {
              cpuTimeP50
              cpuTimeP99
            }
          }
          totals: workersInvocationsAdaptive(
            filter: {
              scriptName: "${scriptName}"
              datetime_gt: "${since}"
            }
            limit: 1
          ) {
            sum {
              requests
              errors
              subrequests
            }
            quantiles {
              cpuTimeP50
              cpuTimeP99
            }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    const data = await res.json() as any;
    const account = data?.data?.viewer?.accounts?.[0];
    const series = account?.series ?? [];
    const totals = account?.totals?.[0] ?? null;

    return c.json({
      scriptName,
      period,
      totals: totals ? {
        requests: totals.sum.requests,
        errors: totals.sum.errors,
        subrequests: totals.sum.subrequests,
        cpuTimeP50: totals.quantiles.cpuTimeP50,
        cpuTimeP99: totals.quantiles.cpuTimeP99,
      } : { requests: 0, errors: 0, subrequests: 0, cpuTimeP50: 0, cpuTimeP99: 0 },
      series: series.map((s: any) => ({
        timestamp: s.dimensions[timeDimension],
        status: s.dimensions.status,
        requests: s.sum.requests,
        errors: s.sum.errors,
        cpuTimeP50: s.quantiles.cpuTimeP50,
        cpuTimeP99: s.quantiles.cpuTimeP99,
      })),
    });
  } catch {
    return c.json({
      scriptName,
      period,
      totals: { requests: 0, errors: 0, subrequests: 0, cpuTimeP50: 0, cpuTimeP99: 0 },
      series: [],
    });
  }
});

/**
 * PATCH /projects/:id/triggers
 *
 * Update project triggers (cron schedules, queue toggle).
 *
 * - cron: applied immediately via CF schedules API. Takes effect within seconds.
 * - queue: stored in project.triggers, but the actual binding lives in the
 *   worker bundle metadata. Toggling queue here only updates the recorded
 *   intent — the change takes effect on next `creek deploy`.
 *
 * Both fields are optional; you can update either or both.
 */
deployments.patch("/:projectId/triggers", requirePermission("deploy:create"), async (c) => {
  const teamId = c.get("teamId");
  const teamSlug = c.get("teamSlug");
  const projectId = c.req.param("projectId");

  const project = await c.env.DB.prepare(
    "SELECT id, slug, triggers FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{ id: string; slug: string; triggers: string | null }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const body = await c.req.json<{ cron?: unknown; queue?: unknown }>().catch(
    () => ({} as { cron?: unknown; queue?: unknown }),
  );
  const cronInput = (body as { cron?: unknown }).cron;
  const queueInput = (body as { queue?: unknown }).queue;

  const updateCron = cronInput !== undefined;
  const updateQueue = queueInput !== undefined;

  if (!updateCron && !updateQueue) {
    return c.json({ error: "validation", message: "Provide at least one of: cron, queue" }, 400);
  }

  if (updateCron && (!Array.isArray(cronInput) || !cronInput.every((s) => typeof s === "string"))) {
    return c.json({ error: "validation", message: "Field 'cron' must be a string array" }, 400);
  }

  if (updateQueue && typeof queueInput !== "boolean") {
    return c.json({ error: "validation", message: "Field 'queue' must be a boolean" }, 400);
  }

  // Read existing triggers (preserve fields not being updated)
  let existing: { cron: string[]; queue: boolean } = { cron: [], queue: false };
  try {
    if (project.triggers) existing = JSON.parse(project.triggers);
  } catch {}

  const newCron = updateCron ? (cronInput as string[]) : existing.cron;
  const newQueue = updateQueue ? (queueInput as boolean) : existing.queue;
  const scriptName = `${project.slug}-${teamSlug}`;

  // Cron applies immediately via CF schedules API
  if (updateCron) {
    try {
      const { updateScriptSchedules } = await import("../resources/cloudflare.js");
      await updateScriptSchedules(c.env, scriptName, newCron);
    } catch (err) {
      return c.json({
        error: "update_failed",
        message: err instanceof Error ? err.message : String(err),
      }, 500);
    }
  }

  // Persist to DB
  const newTriggers = JSON.stringify({ cron: newCron, queue: newQueue });
  await c.env.DB.prepare(
    "UPDATE project SET triggers = ?, updatedAt = ? WHERE id = ?",
  )
    .bind(newTriggers, Date.now(), project.id)
    .run();

  // Audit log
  if (updateCron) {
    await recordAudit(c.env.DB, c.get("user"), c.get("teamId"), {
      action: "trigger.cron.update",
      resourceType: "trigger",
      resourceId: project.id,
      metadata: { projectSlug: project.slug, cron: newCron },
    }, c.get("auditCtx"));
  }
  if (updateQueue && existing.queue !== newQueue) {
    await recordAudit(c.env.DB, c.get("user"), c.get("teamId"), {
      action: "trigger.queue.update",
      resourceType: "trigger",
      resourceId: project.id,
      metadata: { projectSlug: project.slug, queue: newQueue },
    }, c.get("auditCtx"));
  }

  return c.json({
    ok: true,
    cron: newCron,
    queue: newQueue,
    queueRequiresRedeploy: updateQueue && existing.queue !== newQueue,
  });
});

/**
 * POST /projects/:id/queue/send
 * Send a message to the project's auto-provisioned queue.
 */
deployments.post("/:projectId/queue/send", requirePermission("deploy:create"), async (c) => {
  const teamId = c.get("teamId");
  const projectId = c.req.param("projectId");

  const project = await c.env.DB.prepare(
    "SELECT id FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{ id: string }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  // Look up the project's queue via resource bindings
  const { getProjectQueueId } = await import("../resources/service.js");
  const queueId = await getProjectQueueId(c.env, project.id);

  if (!queueId) {
    return c.json({
      error: "queue_not_provisioned",
      message: "This project does not have a queue. Add `queue = true` under [triggers] in creek.toml and redeploy.",
    }, 400);
  }

  const body = await c.req.json<{ message?: unknown }>().catch(() => ({} as { message?: unknown }));
  const messageBody = (body as { message?: unknown }).message;
  if (messageBody === undefined) {
    return c.json({ error: "validation", message: "Missing 'message' field" }, 400);
  }

  try {
    const { sendQueueMessage } = await import("../resources/cloudflare.js");
    await sendQueueMessage(c.env, queueId, messageBody);
    return c.json({ ok: true, queueId });
  } catch (err) {
    return c.json({
      error: "send_failed",
      message: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});

// --- Turbo deploy helpers ---

async function getProjectRepoUrl(
  db: D1Database,
  projectId: string,
): Promise<string | null> {
  const row = await db.prepare(
    "SELECT githubRepo FROM project WHERE id = ?",
  ).bind(projectId).first<{ githubRepo: string | null }>();
  if (!row?.githubRepo) return null;
  // githubRepo is stored as "owner/repo" — normalize to full URL
  return row.githubRepo.startsWith("http")
    ? row.githubRepo
    : `https://github.com/${row.githubRepo}`;
}

/**
 * Deploy from the remote-builder's KV bundle cache. Runs inside
 * waitUntil — no timeout pressure. Mirrors the PUT /bundle handler's
 * deploy path but reads the bundle from cache instead of the request body.
 */
async function deployFromBundleCache(
  env: any,
  project: { id: string; slug: string },
  deployment: {
    id: string;
    teamId: string;
    teamSlug: string;
    branch?: string | null;
    commitSha?: string | null;
  },
  cachedBundleJson: string,
): Promise<void> {
  try {
    // Parse cached bundle (same format as sandbox-api POST /deploy body)
    const bundle = JSON.parse(cachedBundleJson) as {
      assets: Record<string, string>;
      serverFiles?: Record<string, string>;
      manifest: { assets: string[]; hasWorker: boolean; entrypoint: string | null; renderMode: string; framework?: string };
    };

    // Decode assets from base64
    const clientAssets: Record<string, ArrayBuffer> = {};
    for (const [path, b64] of Object.entries(bundle.assets)) {
      const binary = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      clientAssets[path] = binary.buffer;
    }

    const serverFiles: Record<string, ArrayBuffer> | undefined = bundle.serverFiles
      ? Object.fromEntries(
          Object.entries(bundle.serverFiles).map(([path, b64]) => [
            path,
            Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer,
          ]),
        )
      : undefined;

    const renderMode = bundle.manifest.renderMode === "ssr" ? "ssr" : "spa" as const;

    // Update status
    await env.DB.prepare(
      "UPDATE deployment SET status = 'deploying', updatedAt = ? WHERE id = ?",
    ).bind(Date.now(), deployment.id).run();

    // Deploy via the same deployWithAssets used by PUT /bundle
    const { deployWithAssets } = await import("./deploy.js");
    await deployWithAssets(
      env,
      project.slug,
      deployment.teamSlug,
      deployment.id,
      {
        clientAssets,
        serverFiles,
        renderMode,
        teamId: deployment.teamId,
        teamSlug: deployment.teamSlug,
        projectSlug: project.slug,
        plan: "pro",
        bindings: [],
      },
      deployment.branch,
      "main",
    );

    await env.DB.prepare(
      "UPDATE deployment SET status = 'active', updatedAt = ? WHERE id = ?",
    ).bind(Date.now(), deployment.id).run();

    console.log(`[turbo-deploy] ⚡ deployed ${deployment.id} from cache`);
  } catch (err) {
    console.error("[turbo-deploy] deploy-from-cache failed:", err);
    await env.DB.prepare(
      "UPDATE deployment SET status = 'failed', failedStep = 'deploying', errorMessage = ?, updatedAt = ? WHERE id = ?",
    ).bind(
      err instanceof Error ? err.message : String(err),
      Date.now(),
      deployment.id,
    ).run();
  }
}

export { deployments };
