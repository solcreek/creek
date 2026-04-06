import { Hono } from "hono";
import type { Env, AuthUser } from "../../types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { deployWithAssets, shortDeployId } from "./deploy.js";
import { recordAudit } from "../audit/service.js";

type InstantDeployEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; teamId: string; teamSlug: string; auditCtx: AuditRequestContext };
};

const instantDeploy = new Hono<InstantDeployEnv>();

/**
 * Instant Deploy API
 *
 * One HTTP call to go from raw files → live site.
 * Designed for programmatic use by platform integrators
 * (template marketplaces, AI builders, etc.)
 *
 * POST /instant-deploy
 * {
 *   "slug": "johndoe",
 *   "files": {
 *     "index.html": "<!DOCTYPE html>...",
 *     "styles.css": "body { ... }"
 *   },
 *   "framework": "static"      // optional, default "static"
 * }
 *
 * → 201 { url, previewUrl, deploymentId }
 */
instantDeploy.post("/", async (c) => {
  const teamId = c.get("teamId");
  const teamSlug = c.get("teamSlug");

  const body = await c.req.json<{
    slug: string;
    files: Record<string, string>;
    framework?: string;
  }>();

  // Validate slug
  if (!body.slug || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(body.slug)) {
    return c.json(
      { error: "validation", message: "Slug must be lowercase alphanumeric with hyphens" },
      400,
    );
  }

  if (!body.files || Object.keys(body.files).length === 0) {
    return c.json(
      { error: "validation", message: "At least one file is required" },
      400,
    );
  }

  if (!body.files["index.html"]) {
    return c.json(
      { error: "validation", message: "index.html is required" },
      400,
    );
  }

  try {
    // 1. Ensure project exists (create if not)
    let project = await c.env.DB.prepare(
      "SELECT * FROM project WHERE slug = ? AND organizationId = ?",
    )
      .bind(body.slug, teamId)
      .first<{ id: string; slug: string; productionDeploymentId: string | null }>();

    if (!project) {
      const projectId = crypto.randomUUID();
      await c.env.DB.prepare(
        "INSERT INTO project (id, slug, organizationId, framework, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(projectId, body.slug, teamId, body.framework ?? "static", Date.now(), Date.now())
        .run();
      project = { id: projectId, slug: body.slug, productionDeploymentId: null };
    }

    // 2. Create deployment record
    const lastDeploy = await c.env.DB.prepare(
      "SELECT MAX(version) as v FROM deployment WHERE projectId = ?",
    )
      .bind(project.id)
      .first<{ v: number | null }>();

    const version = (lastDeploy?.v ?? 0) + 1;
    const deploymentId = crypto.randomUUID();

    await c.env.DB.prepare(
      "INSERT INTO deployment (id, projectId, version, status, triggerType, createdAt, updatedAt) VALUES (?, ?, ?, 'deploying', 'api', ?, ?)",
    )
      .bind(deploymentId, project.id, version, Date.now(), Date.now())
      .run();

    // 3. Encode files to ArrayBuffer
    const encoder = new TextEncoder();
    const clientAssets: Record<string, ArrayBuffer> = {};
    for (const [path, content] of Object.entries(body.files)) {
      clientAssets[path] = encoder.encode(content).buffer as ArrayBuffer;
    }

    // 4. Get team plan
    const team = await c.env.DB.prepare("SELECT plan FROM organization WHERE id = ?")
      .bind(teamId)
      .first<{ plan: string }>();

    // 5. Deploy via WfP Static Assets (instant deploy = static site, no bindings needed)
    await deployWithAssets(
      c.env,
      body.slug,
      teamSlug,
      deploymentId,
      {
        clientAssets,
        renderMode: "spa",
        teamId,
        teamSlug,
        projectSlug: body.slug,
        plan: team?.plan ?? "free",
        bindings: [],
      },
    );

    // 6. Update DB
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE deployment SET status = 'active', updatedAt = ? WHERE id = ?",
      ).bind(Date.now(), deploymentId),
      c.env.DB.prepare(
        "UPDATE project SET productionDeploymentId = ?, updatedAt = ? WHERE id = ?",
      ).bind(deploymentId, Date.now(), project.id),
    ]);

    await recordAudit(c.env.DB, c.get("user"), c.get("teamId"), {
      action: "instant_deploy.create",
      resourceType: "instant_deploy",
      resourceId: project.id,
      metadata: { slug: body.slug, deploymentId },
    }, c.get("auditCtx"));

    const domain = c.env.CREEK_DOMAIN;
    const shortId = shortDeployId(deploymentId);

    return c.json(
      {
        url: `https://${body.slug}-${teamSlug}.${domain}`,
        previewUrl: `https://${body.slug}-${shortId}-${teamSlug}.${domain}`,
        deploymentId,
        projectId: project.id,
      },
      201,
    );
  } catch (err) {
    return c.json(
      {
        error: "deploy_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * Update an existing site's files and redeploy.
 *
 * PUT /instant-deploy/:slug
 * {
 *   "files": { "index.html": "..." }
 * }
 */
instantDeploy.put("/:slug", async (c) => {
  const teamId = c.get("teamId");
  const teamSlug = c.get("teamSlug");
  const slug = c.req.param("slug");

  const project = await c.env.DB.prepare(
    "SELECT * FROM project WHERE slug = ? AND organizationId = ?",
  )
    .bind(slug, teamId)
    .first<{ id: string; slug: string }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const body = await c.req.json<{ files: Record<string, string> }>();

  if (!body.files || Object.keys(body.files).length === 0) {
    return c.json({ error: "validation", message: "At least one file is required" }, 400);
  }

  try {
    const lastDeploy = await c.env.DB.prepare(
      "SELECT MAX(version) as v FROM deployment WHERE projectId = ?",
    )
      .bind(project.id)
      .first<{ v: number | null }>();

    const version = (lastDeploy?.v ?? 0) + 1;
    const deploymentId = crypto.randomUUID();

    await c.env.DB.prepare(
      "INSERT INTO deployment (id, projectId, version, status, triggerType, createdAt, updatedAt) VALUES (?, ?, ?, 'deploying', 'api', ?, ?)",
    )
      .bind(deploymentId, project.id, version, Date.now(), Date.now())
      .run();

    const encoder = new TextEncoder();
    const clientAssets: Record<string, ArrayBuffer> = {};
    for (const [path, content] of Object.entries(body.files)) {
      clientAssets[path] = encoder.encode(content).buffer as ArrayBuffer;
    }

    const team = await c.env.DB.prepare("SELECT plan FROM organization WHERE id = ?")
      .bind(teamId)
      .first<{ plan: string }>();

    await deployWithAssets(c.env, slug, teamSlug, deploymentId, {
      clientAssets,
      renderMode: "spa",
      teamId,
      teamSlug,
      projectSlug: slug,
      plan: team?.plan ?? "free",
      bindings: [],
    });

    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE deployment SET status = 'active', updatedAt = ? WHERE id = ?",
      ).bind(Date.now(), deploymentId),
      c.env.DB.prepare(
        "UPDATE project SET productionDeploymentId = ?, updatedAt = ? WHERE id = ?",
      ).bind(deploymentId, Date.now(), project.id),
    ]);

    await recordAudit(c.env.DB, c.get("user"), c.get("teamId"), {
      action: "instant_deploy.update",
      resourceType: "instant_deploy",
      resourceId: project.id,
      metadata: { slug, deploymentId },
    }, c.get("auditCtx"));

    const domain = c.env.CREEK_DOMAIN;
    const shortId = shortDeployId(deploymentId);

    return c.json({
      url: `https://${slug}-${teamSlug}.${domain}`,
      previewUrl: `https://${slug}-${shortId}-${teamSlug}.${domain}`,
      deploymentId,
    });
  } catch (err) {
    return c.json(
      { error: "deploy_failed", message: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
});

export { instantDeploy };
