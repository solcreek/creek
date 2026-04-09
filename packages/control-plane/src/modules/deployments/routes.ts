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

  return c.json({ deployment }, 201);
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
  const projectId = c.req.param("projectId");

  const project = await c.env.DB.prepare(
    "SELECT * FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(projectId, projectId, teamId)
    .first<{ id: string }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const rows = await c.env.DB.prepare(
    "SELECT * FROM deployment WHERE projectId = ? ORDER BY version DESC LIMIT 20",
  )
    .bind(project.id)
    .all();

  return c.json(rows.results);
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
  const periodHours = period === "30d" ? 720 : period === "7d" ? 168 : 24;
  const since = new Date(Date.now() - periodHours * 60 * 60 * 1000).toISOString();

  // Use datetimeHour for 7d/30d, datetimeFiveMinutes for 24h
  const timeDimension = periodHours <= 24 ? "datetimeFifteenMinutes" : "datetimeHour";

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

export { deployments };
