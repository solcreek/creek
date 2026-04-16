import type { Env } from "../../types.js";
import { ensureProjectBindings, ensureQueue, buildBindings, type BundleBindingRequirement } from "../resources/service.js";
import { setQueueConsumer } from "../resources/cloudflare.js";
import { deployWithAssets } from "./deploy.js";
import { decrypt } from "../env/crypto.js";
import { deriveRealtimeSecret } from "../realtime/hmac.js";

/**
 * Bundle as stored in R2 staging.
 */
export interface StagedBundle {
  manifest: {
    assets: string[];
    hasWorker: boolean;
    entrypoint: string | null;
    renderMode?: "spa" | "ssr";
  };
  assets: Record<string, string>; // path -> base64
  serverFiles?: Record<string, string>;
  // Typed binding declarations with user-defined names
  bindings?: BundleBindingRequirement[];
  // Wrangler [vars] passthrough
  vars?: Record<string, string>;
  // Wrangler compatibility settings passthrough
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  // Cron trigger schedules
  cron?: string[];
  // Queue trigger
  queue?: boolean;
}

interface DeployJobInput {
  deploymentId: string;
  projectId: string;
  projectSlug: string;
  teamId: string;
  teamSlug: string;
  plan: string;
  branch: string | null;
  productionBranch: string;
  framework?: string | null;
}

/**
 * Run the async deploy pipeline. Called via waitUntil after PUT /bundle returns 202.
 *
 * Steps: read bundle from R2 → provision resources → deploy to WfP → update status.
 * Each step updates deployment status. Failures are recorded with failedStep + errorMessage.
 */
export async function runDeployJob(env: Env, input: DeployJobInput): Promise<void> {
  const { deploymentId, projectId, projectSlug, teamId, teamSlug, plan, branch, productionBranch } = input;

  try {
    // --- Step 1: Read bundle from R2 staging ---
    await setDeploymentStatus(env, deploymentId, "uploading");

    const bundleKey = `bundles/${deploymentId}.json`;
    const bundleObj = await env.ASSETS.get(bundleKey);
    if (!bundleObj) {
      throw new StepError("uploading", "Bundle not found in staging");
    }

    const bundle: StagedBundle = JSON.parse(await bundleObj.text());

    // Decode assets from base64 to ArrayBuffer
    const decodedClientAssets: Record<string, ArrayBuffer> = {};
    for (const [path, b64] of Object.entries(bundle.assets)) {
      const binary = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      decodedClientAssets[path] = binary.buffer;
    }

    const decodedServerFiles: Record<string, ArrayBuffer> | undefined =
      bundle.serverFiles
        ? Object.fromEntries(
            Object.entries(bundle.serverFiles).map(([path, b64]) => [
              path,
              Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer,
            ]),
          )
        : undefined;

    const renderMode = bundle.manifest.renderMode ?? "spa";

    // --- Step 2: Provision resources ---
    await setDeploymentStatus(env, deploymentId, "provisioning");

    const requirements = bundle.bindings ?? [];

    let resolvedBindings;
    try {
      resolvedBindings = await ensureProjectBindings(env, projectId, teamId, requirements);
    } catch (err) {
      throw new StepError("provisioning", err instanceof Error ? err.message : String(err));
    }

    // Provision queue if needed
    let queueResource;
    if (bundle.queue) {
      try {
        queueResource = await ensureQueue(env, projectId, teamId);
      } catch (err) {
        throw new StepError("provisioning", err instanceof Error ? err.message : String(err));
      }
    }

    // Load user-defined environment variables
    const envVarRows = await env.DB.prepare(
      "SELECT key, encryptedValue FROM environment_variable WHERE projectId = ?",
    )
      .bind(projectId)
      .all<{ key: string; encryptedValue: string }>();

    const envVars: { key: string; value: string }[] = [];
    if (env.ENCRYPTION_KEY) {
      for (const row of envVarRows.results) {
        const value = await decrypt(row.encryptedValue, env.ENCRYPTION_KEY);
        envVars.push({ key: row.key, value });
      }
    } else {
      for (const row of envVarRows.results) {
        envVars.push({ key: row.key, value: row.encryptedValue });
      }
    }

    // Inject wrangler [vars] as additional plain text env vars
    if (bundle.vars) {
      for (const [key, value] of Object.entries(bundle.vars)) {
        envVars.push({ key, value });
      }
    }

    // Derive per-project realtime secret via HMAC
    const realtimeSecret = env.REALTIME_MASTER_KEY
      ? await deriveRealtimeSecret(env.REALTIME_MASTER_KEY, projectSlug)
      : undefined;

    const needsAi = requirements.some((r) => r.type === "ai");

    const bindings = buildBindings(resolvedBindings, envVars, {
      projectSlug,
      projectId,
      realtimeUrl: env.CREEK_REALTIME_URL ?? `https://realtime.${env.CREEK_DOMAIN}`,
      realtimeSecret,
      needsAi,
      queueName: queueResource?.cfResourceName,
    });

    // --- Step 3: Deploy to WfP ---
    await setDeploymentStatus(env, deploymentId, "deploying");

    try {
      await deployWithAssets(
        env,
        projectSlug,
        teamSlug,
        deploymentId,
        {
          clientAssets: decodedClientAssets,
          serverFiles: decodedServerFiles,
          renderMode,
          teamId,
          teamSlug,
          projectSlug,
          plan,
          bindings,
          compatibilityDate: bundle.compatibilityDate,
          compatibilityFlags: bundle.compatibilityFlags,
          framework: input.framework ?? null,
          cronSchedules: bundle.cron,
        },
        branch,
        productionBranch,
      );
    } catch (err) {
      throw new StepError("deploying", err instanceof Error ? err.message : String(err));
    }

    // Register production script as queue consumer (after deploy succeeds)
    if (queueResource && (!branch || branch === productionBranch)) {
      const prodScriptName = `${projectSlug}-${teamSlug}`;
      try {
        await setQueueConsumer(env, queueResource.cfResourceId, prodScriptName);
      } catch {
        // Non-fatal: queue consumer registration can be retried on next deploy
      }
    }

    // --- Step 4: Mark active + promote if production ---
    const isProduction = !branch || branch === productionBranch;

    const batchOps = [
      env.DB.prepare(
        "UPDATE deployment SET status = 'active', updatedAt = ? WHERE id = ?",
      ).bind(Date.now(), deploymentId),
    ];

    if (isProduction) {
      // Store triggers metadata on the project for dashboard display
      const triggers = JSON.stringify({
        cron: bundle.cron ?? [],
        queue: bundle.queue ?? false,
      });
      batchOps.push(
        env.DB.prepare(
          "UPDATE project SET productionDeploymentId = ?, triggers = ?, updatedAt = ? WHERE id = ?",
        ).bind(deploymentId, triggers, Date.now(), projectId),
      );
    }

    await env.DB.batch(batchOps);

    // Store manifest in R2 for reference
    const manifestKey = `${projectId}/${deploymentId}/_manifest.json`;
    await env.ASSETS.put(
      manifestKey,
      JSON.stringify({
        ...bundle.manifest,
        projectId,
        deploymentId,
      }),
    );

    // Clean up staging bundle
    await env.ASSETS.delete(bundleKey);
  } catch (err) {
    if (err instanceof StepError) {
      await failDeployment(env, deploymentId, err.step, err.message);
    } else {
      await failDeployment(
        env,
        deploymentId,
        "deploying",
        err instanceof Error ? err.message : "Unknown error",
      );
    }
  }
}

// --- Helpers ---

async function setDeploymentStatus(env: Env, deploymentId: string, status: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE deployment SET status = ?, updatedAt = ? WHERE id = ?",
  )
    .bind(status, Date.now(), deploymentId)
    .run();
}

async function failDeployment(
  env: Env,
  deploymentId: string,
  failedStep: string,
  errorMessage: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE deployment SET status = 'failed', failedStep = ?, errorMessage = ?, updatedAt = ? WHERE id = ?`,
  )
    .bind(failedStep, errorMessage, Date.now(), deploymentId)
    .run();
}

class StepError extends Error {
  constructor(
    public step: string,
    message: string,
  ) {
    super(message);
    this.name = "StepError";
  }
}
