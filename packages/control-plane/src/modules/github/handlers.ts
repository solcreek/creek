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

  // Call remote builder
  try {
    const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

    const buildRes = await fetch(`${env.REMOTE_BUILDER_URL}/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: cloneUrl, branch }),
    });

    const buildResult = await buildRes.json() as any;

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
