/**
 * Authenticated GitHub routes — called by the dashboard.
 * Protected by tenantMiddleware (user must be logged in).
 */

import { Hono } from "hono";
import type { Env } from "../../types.js";
import type { AuthUser } from "../tenant/types.js";
import { exchangeInstallationToken, getLatestCommit, listInstallationRepos } from "./api.js";
import { handlePush } from "./handlers.js";
import { scanRepo } from "./scan.js";

type GitHubEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; teamId: string; teamSlug: string };
};

const github = new Hono<GitHubEnv>();

// --- List installations for current team ---

github.get("/installations", async (c) => {
  const teamId = c.get("teamId");

  const rows = await c.env.DB.prepare(
    "SELECT * FROM github_installation WHERE organizationId = ? ORDER BY updatedAt DESC",
  )
    .bind(teamId)
    .all();

  return c.json(rows.results);
});

// --- Claim an installation (associate with current team) ---

github.post("/installations/:id/claim", async (c) => {
  const teamId = c.get("teamId");
  const installationId = parseInt(c.req.param("id"), 10);

  if (isNaN(installationId)) {
    return c.json({ error: "validation", message: "Invalid installation ID" }, 400);
  }

  // Check installation exists
  const installation = await c.env.DB.prepare(
    "SELECT id, organizationId FROM github_installation WHERE id = ?",
  )
    .bind(installationId)
    .first<{ id: number; organizationId: string | null }>();

  if (!installation) {
    return c.json({ error: "not_found", message: "Installation not found" }, 404);
  }

  // If already claimed by another team, reject
  if (installation.organizationId && installation.organizationId !== teamId) {
    return c.json({ error: "conflict", message: "Installation already claimed by another team" }, 409);
  }

  // Claim it
  await c.env.DB.prepare(
    "UPDATE github_installation SET organizationId = ?, updatedAt = ? WHERE id = ?",
  )
    .bind(teamId, Date.now(), installationId)
    .run();

  return c.json({ ok: true });
});

// --- List repos for an installation (with scan data) ---

github.get("/installations/:id/repos", async (c) => {
  const teamId = c.get("teamId");
  const installationId = parseInt(c.req.param("id"), 10);

  // Verify installation belongs to this team
  const installation = await c.env.DB.prepare(
    "SELECT id FROM github_installation WHERE id = ? AND organizationId = ?",
  )
    .bind(installationId, teamId)
    .first();

  if (!installation) {
    return c.json({ error: "not_found", message: "Installation not found for this team" }, 404);
  }

  // Get installation token + list repos from GitHub
  const token = await exchangeInstallationToken(c.env, installationId);
  const repos = await listInstallationRepos(token);

  // Get scan data
  const scans = await c.env.DB.prepare(
    "SELECT * FROM repo_scan WHERE installationId = ?",
  )
    .bind(installationId)
    .all<{
      repoOwner: string;
      repoName: string;
      framework: string | null;
      configType: string | null;
      bindings: string | null;
      envHints: string | null;
      deployable: number;
      scannedAt: number;
    }>();

  const scanMap = new Map(
    scans.results.map((s) => [`${s.repoOwner}/${s.repoName}`, s]),
  );

  // Merge GitHub repo data with scan results
  const enriched = repos.map((repo) => {
    const scan = scanMap.get(repo.full_name);
    return {
      ...repo,
      scan: scan
        ? {
            framework: scan.framework,
            configType: scan.configType,
            bindings: scan.bindings ? JSON.parse(scan.bindings) : [],
            envHints: scan.envHints ? JSON.parse(scan.envHints) : [],
            deployable: !!scan.deployable,
            scannedAt: scan.scannedAt,
          }
        : null,
    };
  });

  return c.json(enriched);
});

// --- Connect repo to project ---

github.post("/connect", async (c) => {
  const teamId = c.get("teamId");
  const body = await c.req.json<{
    projectId: string;
    installationId: number;
    repoOwner: string;
    repoName: string;
    productionBranch?: string;
  }>();

  if (!body.projectId || !body.installationId || !body.repoOwner || !body.repoName) {
    return c.json({ error: "validation", message: "projectId, installationId, repoOwner, repoName are required" }, 400);
  }

  // Verify project belongs to this team
  const project = await c.env.DB.prepare(
    "SELECT id FROM project WHERE id = ? AND organizationId = ?",
  )
    .bind(body.projectId, teamId)
    .first();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  // Check for existing connection on this project
  const existing = await c.env.DB.prepare(
    "SELECT id FROM github_connection WHERE projectId = ?",
  )
    .bind(body.projectId)
    .first();

  if (existing) {
    return c.json({ error: "conflict", message: "Project already has a GitHub connection. Disconnect first." }, 409);
  }

  // Check repo not already connected to another project
  const repoConnected = await c.env.DB.prepare(
    "SELECT projectId FROM github_connection WHERE repoOwner = ? AND repoName = ?",
  )
    .bind(body.repoOwner, body.repoName)
    .first<{ projectId: string }>();

  if (repoConnected) {
    return c.json({ error: "conflict", message: `This repo is already connected to another project` }, 409);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO github_connection (id, projectId, installationId, repoOwner, repoName, productionBranch, autoDeployEnabled, previewEnabled, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`,
  )
    .bind(id, body.projectId, body.installationId, body.repoOwner, body.repoName, body.productionBranch ?? "main", Date.now())
    .run();

  // Also update project.githubRepo
  await c.env.DB.prepare(
    "UPDATE project SET githubRepo = ?, updatedAt = ? WHERE id = ?",
  )
    .bind(`${body.repoOwner}/${body.repoName}`, Date.now(), body.projectId)
    .run();

  return c.json({ ok: true, connectionId: id }, 201);
});

// --- Trigger initial deploy from latest commit on production branch ---

github.post("/deploy-latest", async (c) => {
  const teamId = c.get("teamId");
  const body = await c.req.json<{ projectId: string }>();

  if (!body.projectId) {
    return c.json({ error: "validation", message: "projectId is required" }, 400);
  }

  // Accept either the project UUID or slug — the dashboard's project detail
  // route (/projects/$projectId) allows both forms in the URL, and the
  // existing GET /projects/:idOrSlug endpoint mirrors this. Resolve to the
  // canonical UUID before looking up the GitHub connection so either works.
  const project = await c.env.DB.prepare(
    "SELECT id FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
  )
    .bind(body.projectId, body.projectId, teamId)
    .first<{ id: string }>();

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  // Load connection + verify team ownership
  const connection = await c.env.DB.prepare(
    `SELECT gc.installationId, gc.repoOwner, gc.repoName, gc.productionBranch
     FROM github_connection gc
     JOIN project p ON gc.projectId = p.id
     WHERE gc.projectId = ? AND p.organizationId = ?`,
  )
    .bind(project.id, teamId)
    .first<{
      installationId: number;
      repoOwner: string;
      repoName: string;
      productionBranch: string;
    }>();

  if (!connection) {
    return c.json({ error: "not_found", message: "Project has no GitHub connection" }, 404);
  }

  // Exchange token and fetch latest commit on production branch
  const token = await exchangeInstallationToken(c.env, connection.installationId);
  const commit = await getLatestCommit(token, connection.repoOwner, connection.repoName, connection.productionBranch);
  if (!commit) {
    return c.json(
      { error: "not_found", message: `Branch '${connection.productionBranch}' not found on ${connection.repoOwner}/${connection.repoName}` },
      404,
    );
  }

  // Synthesize a push payload and dispatch handlePush in background
  const payload = {
    ref: `refs/heads/${connection.productionBranch}`,
    after: commit.sha,
    head_commit: { message: commit.message },
    repository: {
      owner: { login: connection.repoOwner },
      name: connection.repoName,
      clone_url: `https://github.com/${connection.repoOwner}/${connection.repoName}.git`,
    },
    installation: { id: connection.installationId },
  };

  c.executionCtx.waitUntil(
    handlePush(c.env, payload).catch((err) => {
      console.error("[deploy-latest] handlePush failed:", err);
    }),
  );

  return c.json({ ok: true, commitSha: commit.sha, branch: connection.productionBranch });
});

// --- Disconnect ---

github.delete("/connections/:id", async (c) => {
  const teamId = c.get("teamId");
  const connectionId = c.req.param("id");

  // Verify connection belongs to a project in this team
  const connection = await c.env.DB.prepare(
    `SELECT gc.id, gc.projectId FROM github_connection gc
     JOIN project p ON gc.projectId = p.id
     WHERE gc.id = ? AND p.organizationId = ?`,
  )
    .bind(connectionId, teamId)
    .first<{ id: string; projectId: string }>();

  if (!connection) {
    return c.json({ error: "not_found", message: "Connection not found" }, 404);
  }

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM github_connection WHERE id = ?").bind(connectionId),
    c.env.DB.prepare("UPDATE project SET githubRepo = NULL, updatedAt = ? WHERE id = ?").bind(Date.now(), connection.projectId),
  ]);

  return c.json({ ok: true });
});

// --- List connections for team ---

github.get("/connections", async (c) => {
  const teamId = c.get("teamId");

  const rows = await c.env.DB.prepare(
    `SELECT gc.*, p.slug as projectSlug FROM github_connection gc
     JOIN project p ON gc.projectId = p.id
     WHERE p.organizationId = ?
     ORDER BY gc.createdAt DESC`,
  )
    .bind(teamId)
    .all();

  return c.json(rows.results);
});

// --- Trigger re-scan ---

github.post("/scan/:owner/:repo", async (c) => {
  const teamId = c.get("teamId");
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");

  // Find installation for this repo that belongs to this team
  const scan = await c.env.DB.prepare(
    `SELECT rs.installationId FROM repo_scan rs
     JOIN github_installation gi ON rs.installationId = gi.id
     WHERE rs.repoOwner = ? AND rs.repoName = ? AND gi.organizationId = ?`,
  )
    .bind(owner, repo, teamId)
    .first<{ installationId: number }>();

  if (!scan) {
    return c.json({ error: "not_found", message: "Repo not found or not accessible" }, 404);
  }

  const token = await exchangeInstallationToken(c.env, scan.installationId);
  const result = await scanRepo(token, owner, repo);

  // Update scan cache
  await c.env.DB.prepare(
    `INSERT INTO repo_scan (repoOwner, repoName, installationId, framework, configType, bindings, envHints, deployable, scannedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repoOwner, repoName) DO UPDATE SET
       framework = ?, configType = ?, bindings = ?, envHints = ?, deployable = ?, scannedAt = ?`,
  )
    .bind(
      owner, repo, scan.installationId,
      result.framework, result.configType,
      JSON.stringify(result.bindings), JSON.stringify(result.envHints),
      result.deployable ? 1 : 0, Date.now(),
      result.framework, result.configType,
      JSON.stringify(result.bindings), JSON.stringify(result.envHints),
      result.deployable ? 1 : 0, Date.now(),
    )
    .run();

  return c.json(result);
});

export { github };
