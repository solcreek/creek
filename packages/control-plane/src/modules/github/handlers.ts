/**
 * GitHub webhook event handlers.
 *
 * These run in waitUntil — the webhook endpoint returns 200 immediately.
 */

import type { Env } from "../../types.js";
import * as schema from "../../db/schema.js";
import { exchangeInstallationToken, createCommitStatus, createOrUpdatePRComment, formatPreviewComment } from "./api.js";
import { scanRepo } from "./scan.js";

// --- Types for GitHub webhook payloads ---

export interface PushPayload {
  ref: string;
  after: string;
  head_commit?: { message: string } | null;
  repository: { owner: { login: string }; name: string; clone_url: string };
  installation?: { id: number };
}

export interface PullRequestPayload {
  action: string;
  number: number;
  pull_request: { head: { ref: string; sha: string }; base: { ref: string } };
  repository: { owner: { login: string }; name: string; clone_url: string };
  installation?: { id: number };
}

export interface InstallationPayload {
  action: string;
  installation: { id: number; account: { login: string; type: string }; app_id: number };
  repositories?: Array<{ name: string; full_name: string }>;
}

export interface RepositoryEventPayload {
  action: string;
  // GitHub sends the full post-change repository object, which always has
  // `id` (stable) plus `name` + `owner.login`. For `renamed` events the
  // `changes.repository.name.from` field carries the old name.
  repository: {
    id: number;
    name: string;
    owner: { login: string };
  };
  changes?: {
    repository?: {
      name?: { from: string };
    };
  };
  installation?: { id: number };
}

// --- Handler: Repository Events ---

/**
 * Handle the `repository` webhook event. GitHub sends these for renamed,
 * transferred, edited (description/topics/etc), publicized/privatized,
 * archived/unarchived, and deleted repositories.
 *
 * We only care about the first two — both change (owner, name) while
 * leaving the internal `repository.id` stable — so we look the connection
 * up by that ID and sync the row.
 *
 * If the connection row has `repoId = NULL` (pre-C2 row or one where the
 * getRepoInfo call failed at connect time), we fall back to matching on
 * (repoOwner, repoName) from the payload's `changes.repository.name.from`
 * for renames, and opportunistically backfill repoId while we're at it.
 */
export async function handleRepository(
  env: Env,
  payload: RepositoryEventPayload,
): Promise<void> {
  const { action, repository, changes } = payload;

  // Only act on shape-changing events
  if (action !== "renamed" && action !== "transferred") return;

  const newOwner = repository.owner.login;
  const newName = repository.name;
  const repoId = repository.id;

  // Try to find the connection by repoId first (stable across renames)
  let connection = await env.DB.prepare(
    "SELECT id, projectId, repoId, repoOwner, repoName FROM github_connection WHERE repoId = ?",
  )
    .bind(repoId)
    .first<{ id: string; projectId: string; repoId: number | null; repoOwner: string; repoName: string }>();

  // Fallback: legacy row with null repoId. Match on (old owner, old name).
  // For renames that's `changes.repository.name.from` + unchanged owner.
  // For transfers GitHub doesn't provide the old owner in changes, so we
  // can't safely match legacy rows on a transfer — skip and log.
  if (!connection && action === "renamed" && changes?.repository?.name?.from) {
    connection = await env.DB.prepare(
      "SELECT id, projectId, repoId, repoOwner, repoName FROM github_connection WHERE repoOwner = ? AND repoName = ?",
    )
      .bind(newOwner, changes.repository.name.from)
      .first<{ id: string; projectId: string; repoId: number | null; repoOwner: string; repoName: string }>();
  }

  if (!connection) {
    console.log(
      `[github/repository] no connection found for repoId=${repoId} (${newOwner}/${newName}) action=${action}`,
    );
    return;
  }

  // Update the connection to point at the new owner/name, and backfill
  // repoId if it was null.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE github_connection
       SET repoOwner = ?, repoName = ?, repoId = ?
       WHERE id = ?`,
    ).bind(newOwner, newName, repoId, connection.id),
    env.DB.prepare(
      "UPDATE project SET githubRepo = ?, updatedAt = ? WHERE id = ?",
    ).bind(`${newOwner}/${newName}`, Date.now(), connection.projectId),
  ]);
}

// --- Handler: Installation Events ---

export async function handleInstallation(env: Env, payload: InstallationPayload): Promise<void> {
  const { installation, action, repositories } = payload;

  if (action === "created") {
    // Upsert installation record
    await env.DB.prepare(
      `INSERT INTO github_installation (id, accountLogin, accountType, appId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updatedAt = ?`,
    )
      .bind(
        installation.id,
        installation.account.login,
        installation.account.type,
        installation.app_id,
        Date.now(),
        Date.now(),
        Date.now(),
      )
      .run();

    // Background scan all repos
    if (repositories) {
      const token = await exchangeInstallationToken(env, installation.id);
      for (const repo of repositories) {
        const [owner, name] = repo.full_name.split("/");
        try {
          const result = await scanRepo(token, owner, name);
          await upsertRepoScan(env, owner, name, installation.id, result);
        } catch {
          // Scan failed — skip, will retry on next webhook
        }
      }
    }
  }

  if (action === "deleted") {
    // Clean up: delete installation + connections + scans
    await env.DB.batch([
      env.DB.prepare("DELETE FROM github_connection WHERE installationId = ?").bind(installation.id),
      env.DB.prepare("DELETE FROM repo_scan WHERE installationId = ?").bind(installation.id),
      env.DB.prepare("DELETE FROM github_installation WHERE id = ?").bind(installation.id),
    ]);
  }
}

// --- Handler: Push Events ---

export async function handlePush(env: Env, payload: PushPayload): Promise<void> {
  const { repository, ref, after, head_commit, installation } = payload;
  const branch = ref.replace("refs/heads/", "");
  const owner = repository.owner.login;
  const repo = repository.name;

  // Find connected project
  const connection = await env.DB.prepare(
    "SELECT * FROM github_connection WHERE repoOwner = ? AND repoName = ?",
  )
    .bind(owner, repo)
    .first<{
      id: string;
      projectId: string;
      installationId: number;
      productionBranch: string;
      autoDeployEnabled: number;
      previewEnabled: number;
    }>();

  if (!connection) return; // Not connected — no-op
  if (!connection.autoDeployEnabled) return;

  const isProduction = branch === connection.productionBranch;
  if (!isProduction && !connection.previewEnabled) return;

  if (!installation) return;

  const token = await exchangeInstallationToken(env, installation.id);

  // Get project + team info
  const project = await env.DB.prepare(
    `SELECT p.slug, o.slug as teamSlug, o.id as teamId, o.plan
     FROM project p JOIN organization o ON p.organizationId = o.id
     WHERE p.id = ?`,
  )
    .bind(connection.projectId)
    .first<{ slug: string; teamSlug: string; teamId: string; plan: string }>();

  if (!project) return;

  // Post commit status: pending
  await createCommitStatus(token, owner, repo, after, "pending", {
    description: isProduction ? "Deploying to production..." : `Preview for ${branch}...`,
    context: "Creek",
  });

  // Create deployment record
  const deploymentId = crypto.randomUUID();
  const lastDeploy = await env.DB.prepare(
    "SELECT MAX(version) as v FROM deployment WHERE projectId = ?",
  )
    .bind(connection.projectId)
    .first<{ v: number | null }>();

  const version = (lastDeploy?.v ?? 0) + 1;

  await env.DB.prepare(
    `INSERT INTO deployment (id, projectId, version, status, branch, commitSha, commitMessage, triggerType, createdAt, updatedAt)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, 'github', ?, ?)`,
  )
    .bind(
      deploymentId,
      connection.projectId,
      version,
      branch,
      after,
      head_commit?.message?.slice(0, 500) ?? null,
      Date.now(),
      Date.now(),
    )
    .run();

  // Call remote builder via service binding (matches deploy-api/src/index.ts:131)
  try {
    const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

    const buildRes = await env.REMOTE_BUILDER.fetch("http://remote-builder/build", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": env.INTERNAL_SECRET,
      },
      body: JSON.stringify({ repoUrl: cloneUrl, branch }),
    });

    const buildResult = await buildRes.json() as any;

    // Ship the container's build log to R2 immediately — regardless of
    // success/failure, the dashboard panel should have something. Ignore
    // errors silently; a missing build log is strictly less bad than a
    // failed deploy call.
    if (Array.isArray(buildResult.logs) && buildResult.logs.length > 0) {
      try {
        const { storeBuildLog } = await import("../build-logs/storage.js");
        const ndjson = (buildResult.logs as unknown[])
          .map((l) => JSON.stringify(l))
          .join("\n");
        await storeBuildLog(env, {
          team: project.teamSlug,
          project: project.slug,
          deploymentId,
          status: buildResult.success ? "running" : "failed",
          startedAt: Date.now() - (Number(buildResult.timing?.total) || 0),
          endedAt: Date.now(),
          body: ndjson,
          errorCode: buildResult.success ? null : (buildResult.error ?? null),
          errorStep: buildResult.success ? null : "build",
        });
      } catch {
        // best-effort
      }
    }

    if (!buildResult.success) {
      await failDeployment(env, deploymentId, "building", buildResult.error || "Build failed");
      await createCommitStatus(token, owner, repo, after, "failure", {
        description: `Build failed: ${buildResult.error || "unknown"}`,
        context: "Creek",
      });
      return;
    }

    // Stage bundle to R2 + mark uploading
    const bundleKey = `bundles/${deploymentId}.json`;
    await env.ASSETS.put(bundleKey, JSON.stringify(buildResult.bundle));

    await env.DB.prepare(
      "UPDATE deployment SET status = 'uploading', updatedAt = ? WHERE id = ?",
    )
      .bind(Date.now(), deploymentId)
      .run();

    // Import and run the deploy job (same pipeline as CLI deploys)
    const { runDeployJob } = await import("../deployments/deploy-job.js");
    await runDeployJob(env, {
      deploymentId,
      projectId: connection.projectId,
      projectSlug: project.slug,
      teamId: project.teamId,
      teamSlug: project.teamSlug,
      plan: project.plan ?? "free",
      branch,
      productionBranch: connection.productionBranch,
      framework: buildResult.config?.framework ?? null,
    });

    // Check final status
    const deployment = await env.DB.prepare(
      "SELECT status, failedStep, errorMessage FROM deployment WHERE id = ?",
    )
      .bind(deploymentId)
      .first<{ status: string; failedStep: string | null; errorMessage: string | null }>();

    // Reflect the final deploy outcome in the build-log metadata row.
    // We already wrote logs with status="running" right after the build
    // step returned — now that the deploy pipeline has finished we know
    // whether it's truly success/failed.
    try {
      const finalStatus = deployment?.status === "active" ? "success" : "failed";
      await env.DB.prepare(
        `UPDATE build_log
         SET status = ?, endedAt = ?, errorStep = COALESCE(?, errorStep), errorCode = COALESCE(?, errorCode)
         WHERE deploymentId = ?`,
      )
        .bind(
          finalStatus,
          Date.now(),
          deployment?.failedStep ?? null,
          deployment?.errorMessage ? deployment.errorMessage.slice(0, 80) : null,
          deploymentId,
        )
        .run();
    } catch {
      // non-fatal
    }

    if (deployment?.status === "active") {
      const domain = env.CREEK_DOMAIN;
      const shortId = deploymentId.slice(0, 8);
      const url = isProduction
        ? `https://${project.slug}-${project.teamSlug}.${domain}`
        : `https://${project.slug}-${shortId}-${project.teamSlug}.${domain}`;

      await createCommitStatus(token, owner, repo, after, "success", {
        description: isProduction ? "Deployed to production" : "Preview ready",
        targetUrl: url,
        context: "Creek",
      });
    } else {
      await createCommitStatus(token, owner, repo, after, "failure", {
        description: `Deploy failed: ${deployment?.errorMessage || "unknown"}`,
        context: "Creek",
      });
    }
  } catch (err) {
    await failDeployment(env, deploymentId, "building", err instanceof Error ? err.message : String(err));
    await createCommitStatus(token, owner, repo, after, "failure", {
      description: "Deploy failed",
      context: "Creek",
    }).catch(() => {}); // Best effort
  }
}

// --- Handler: Pull Request Events ---

export async function handlePullRequest(env: Env, payload: PullRequestPayload): Promise<void> {
  if (!["opened", "synchronize", "reopened"].includes(payload.action)) return;

  const { pull_request, repository, installation } = payload;
  const branch = pull_request.head.ref;
  const sha = pull_request.head.sha;
  const owner = repository.owner.login;
  const repo = repository.name;

  // Find connected project
  const connection = await env.DB.prepare(
    "SELECT * FROM github_connection WHERE repoOwner = ? AND repoName = ?",
  )
    .bind(owner, repo)
    .first<{
      id: string;
      projectId: string;
      installationId: number;
      productionBranch: string;
      previewEnabled: number;
    }>();

  if (!connection || !connection.previewEnabled) return;
  if (!installation) return;

  const token = await exchangeInstallationToken(env, installation.id);

  // Post status: pending
  await createCommitStatus(token, owner, repo, sha, "pending", {
    description: "Building preview...",
    context: "Creek Preview",
  });

  // Reuse push handler logic for the actual deploy (pass branch to handlePush-like flow)
  // For simplicity, construct a push-like payload and delegate
  await handlePush(env, {
    ref: `refs/heads/${branch}`,
    after: sha,
    head_commit: null,
    repository,
    installation,
  });

  // After deploy, post PR comment
  const project = await env.DB.prepare(
    `SELECT p.slug, o.slug as teamSlug FROM project p
     JOIN organization o ON p.organizationId = o.id WHERE p.id = ?`,
  )
    .bind(connection.projectId)
    .first<{ slug: string; teamSlug: string }>();

  if (project) {
    const domain = env.CREEK_DOMAIN;
    const shortId = sha.slice(0, 8); // Use commit SHA for unique preview
    const previewUrl = `${project.slug}-git-${branch}-${project.teamSlug}.${domain}`;

    const comment = formatPreviewComment(previewUrl, 0, null, 0, 0);
    await createOrUpdatePRComment(token, owner, repo, payload.number, comment).catch(() => {});
  }
}

// --- Helpers ---

async function failDeployment(env: Env, deploymentId: string, step: string, message: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE deployment SET status = 'failed', failedStep = ?, errorMessage = ?, updatedAt = ? WHERE id = ?",
  )
    .bind(step, message.slice(0, 1000), Date.now(), deploymentId)
    .run();
}

async function upsertRepoScan(
  env: Env,
  owner: string,
  name: string,
  installationId: number,
  result: Awaited<ReturnType<typeof scanRepo>>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repo_scan (repoOwner, repoName, installationId, framework, configType, bindings, envHints, deployable, scannedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repoOwner, repoName) DO UPDATE SET
       framework = ?, configType = ?, bindings = ?, envHints = ?, deployable = ?, scannedAt = ?`,
  )
    .bind(
      owner, name, installationId,
      result.framework, result.configType,
      JSON.stringify(result.bindings), JSON.stringify(result.envHints),
      result.deployable ? 1 : 0, Date.now(),
      // ON CONFLICT update values
      result.framework, result.configType,
      JSON.stringify(result.bindings), JSON.stringify(result.envHints),
      result.deployable ? 1 : 0, Date.now(),
    )
    .run();
}
