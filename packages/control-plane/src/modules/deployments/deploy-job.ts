import type { Env } from "../../types.js";
import {
  ensureProjectBindings,
  ensureQueue,
  buildBindings,
  type BundleBindingRequirement,
} from "../resources/service.js";
import { setQueueConsumer } from "../resources/cloudflare.js";
import { resolveDeployTarget } from "./target.js";
import { decrypt } from "../env/crypto.js";
import { deriveRealtimeSecret } from "../realtime/hmac.js";
import { storeBuildLogIfAbsent } from "../build-logs/storage.js";
import { classifyDeployFailure } from "../build-logs/classify.js";
import type {
  BuildLogLine,
  BuildLogLevel,
  BuildLogStep,
  BuildLogStatus,
} from "../build-logs/types.js";

/**
 * Bundle as stored in R2 staging.
 */
export interface StagedBundle {
  manifest: {
    assets: string[];
    hasWorker: boolean;
    entrypoint: string | null;
    renderMode?: "spa" | "ssr" | "worker";
  };
  assets: Record<string, string>; // path -> base64
  /** Legacy: server files inlined as base64 (older CLI). */
  serverFiles?: Record<string, string>;
  /**
   * Current: names of server files staged as separate binary R2 objects
   * (see {@link serverFileKey}). Keeps the big worker+wasm out of this JSON so
   * the deploy job doesn't OOM. Mutually exclusive with `serverFiles`.
   */
  serverFileNames?: string[];
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

export interface DeployJobInput {
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
 * Queue consumer for deploy jobs (creek-deploy-jobs).
 *
 * Deploy jobs run here — NOT in the bundle-upload request's waitUntil — because
 * workerd cancels waitUntil work ~30 seconds after the response is sent. A large
 * worker's activation (2-3 sequential multi-MB script PUTs to the CF API) can
 * exceed that, and the cancellation is silent: the heartbeat (first beat at 60s,
 * past the budget) never lands, the deployment sticks in 'deploying', and the
 * stale-deploy reaper misreports it as an activation timeout ~10 minutes later.
 * A queue invocation has a wall-clock budget in the minutes — the job is
 * I/O-bound (sub-second CPU), so it fits comfortably.
 *
 * runDeployJob handles its own failures (marks the deployment failed) and does
 * not normally throw, so a throw here means infra-level death (eviction) — retry
 * the message: the staged bundle is still in R2 (cleanup runs only on job
 * completion) and script PUTs are idempotent, so a re-run is safe. Exported for
 * tests; index.ts's queue() delegates here.
 */
/** Runtime shape check for a queue message body — see consumeDeployJobBatch. */
function isDeployJobInput(body: unknown): body is DeployJobInput {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.deploymentId === "string" &&
    typeof b.projectId === "string" &&
    typeof b.projectSlug === "string" &&
    typeof b.teamId === "string" &&
    typeof b.teamSlug === "string" &&
    typeof b.productionBranch === "string" &&
    typeof b.plan === "string" &&
    (b.branch === null || typeof b.branch === "string") &&
    (b.framework === undefined || b.framework === null || typeof b.framework === "string")
  );
}

export async function consumeDeployJobBatch(
  batch: { messages: ReadonlyArray<{ readonly body: unknown; ack(): void; retry(): void }> },
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    // A malformed body (schema drift, manual enqueue) would make runDeployJob
    // throw before it can even mark the deployment failed — retrying such a
    // poison message is pointless. Ack it with a loud log instead. The log
    // stringify must itself be crash-proof (JSON.stringify throws on BigInt,
    // which structured-clone bodies can carry) — a throw here would escape the
    // loop before the ack and re-create the poison-retry problem.
    if (!isDeployJobInput(msg.body)) {
      let desc: string;
      try {
        desc = JSON.stringify(msg.body);
      } catch {
        desc = String(msg.body);
      }
      console.error("[deploy-jobs] malformed message body, acking:", desc);
      msg.ack();
      continue;
    }
    try {
      await runDeployJob(env, msg.body);
      msg.ack();
    } catch (err) {
      console.error("[deploy-jobs] job crashed, retrying message:", err);
      msg.retry();
    }
  }
}

/**
 * Run the async deploy pipeline. Called via waitUntil after PUT /bundle returns 202.
 *
 * Steps: read bundle from R2 → provision resources → deploy to WfP → update status.
 * Each step updates deployment status. Failures are recorded with failedStep + errorMessage.
 */
export async function runDeployJob(env: Env, input: DeployJobInput): Promise<void> {
  const { deploymentId, projectId, projectSlug, teamId, teamSlug, plan, branch, productionBranch } =
    input;

  // Accumulate a structured server-side log across the deploy stages so a
  // deploy that fails at upload/provision/activate isn't log-less. Persisted
  // at terminal time (best-effort) — see persistDeployLog for why it never
  // overwrites a client/remote-builder log.
  const startedAt = Date.now();
  const logLines: BuildLogLine[] = [];
  const log = (step: BuildLogStep, level: BuildLogLevel, msg: string, code?: string) => {
    logLines.push({ ts: Date.now(), step, stream: "creek", level, msg, ...(code ? { code } : {}) });
  };
  let outcome: { status: BuildLogStatus; errorStep: string | null; errorCode: string | null } = {
    status: "success",
    errorStep: null,
    errorCode: null,
  };

  try {
    // --- Step 1: Read bundle from R2 staging ---
    await setDeploymentStatus(env, deploymentId, "uploading");
    log("upload", "info", "Reading bundle from staging");

    const bundleKey = `bundles/${deploymentId}.json`;
    const bundleObj = await env.ASSETS.get(bundleKey);
    if (!bundleObj) {
      throw new StepError("uploading", "Bundle not found in staging");
    }

    // Parse + base64-decode the bundle. A malformed bundle (bad JSON, invalid
    // base64) is an "uploading"-stage failure — attribute it there rather than
    // letting it fall through to the outer catch's default "deploying" step.
    let bundle: StagedBundle;
    let decodedClientAssets: Record<string, ArrayBuffer>;
    try {
      bundle = JSON.parse(await bundleObj.text());
      decodedClientAssets = decodeBundleAssets(bundle);
    } catch (err) {
      throw new StepError(
        "uploading",
        `Malformed bundle: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Server files (worker.js + the ~3.5MB Prisma/og wasm) are the memory-heavy
    // part. A new CLI stages them as separate BINARY R2 objects (serverFileNames)
    // so we read them as ArrayBuffers directly — never base64-in-JSON — which is
    // what keeps this 128MB Worker from OOMing on a large real bundle. An older
    // CLI still inlines them (serverFiles); resolveServerFiles handles both. A
    // failure here (a staged file missing from R2, or an SSR bundle with no
    // server files) is an "uploading" problem but NOT a malformed bundle — keep
    // its real message rather than mislabelling it.
    let decodedServerFiles: Record<string, ArrayBuffer> | undefined;
    try {
      decodedServerFiles = await resolveServerFiles(env, deploymentId, bundle);
    } catch (err) {
      throw new StepError("uploading", err instanceof Error ? err.message : String(err));
    }

    // Count server files from the decoded result so the log is accurate for
    // both the binary-R2 (serverFileNames) and legacy-inline paths.
    const serverFileCount = decodedServerFiles ? Object.keys(decodedServerFiles).length : 0;
    log(
      "upload",
      "info",
      `Bundle read: ${Object.keys(bundle.assets).length} asset(s)` +
        (serverFileCount > 0 ? `, ${serverFileCount} server file(s)` : ""),
    );

    const renderMode = bundle.manifest.renderMode ?? "spa";

    // --- Step 2: Provision resources ---
    await setDeploymentStatus(env, deploymentId, "provisioning");
    log("provision", "info", "Provisioning resources");

    const requirements = bundle.bindings ?? [];

    let resolvedBindings;
    try {
      resolvedBindings = await ensureProjectBindings(env, projectId, teamId, requirements);
    } catch (err) {
      throw new StepError("provisioning", err instanceof Error ? err.message : String(err));
    }
    log("provision", "info", `Bindings ready (${requirements.length} declared)`);

    // Provision queue if needed
    let queueResource;
    if (bundle.queue) {
      try {
        queueResource = await ensureQueue(env, projectId, teamId);
        log("provision", "info", "Queue provisioned");
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
    log("activate", "info", "Deploying to the edge (Workers for Platforms)");

    try {
      // Uploading an asset-heavy app's files to the edge can legitimately run
      // for several minutes. The stale-deploy reaper fails any deployment whose
      // updatedAt is older than its threshold, so without a heartbeat a
      // slow-but-progressing upload gets killed mid-flight ("Deploy timed
      // out"). Beat updatedAt on an interval for the duration of the deploy so
      // the reaper only fires when the job is genuinely stuck (its waitUntil
      // context died and the heartbeat stopped).
      const target = resolveDeployTarget(env);
      await withDeployHeartbeat(env, deploymentId, () =>
        target.deploy(
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
        ),
      );
    } catch (err) {
      throw new StepError("deploying", err instanceof Error ? err.message : String(err));
    }
    log("activate", "info", "Edge deploy complete");

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
      env.DB.prepare("UPDATE deployment SET status = 'active', updatedAt = ? WHERE id = ?").bind(
        Date.now(),
        deploymentId,
      ),
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

    log("activate", "info", isProduction ? "Deployment active (production)" : "Deployment active");
  } catch (err) {
    const step = err instanceof StepError ? err.step : "deploying";
    const message = err instanceof Error ? err.message : "Unknown error";
    // Record the failure into the log/outcome FIRST, so the finally persists
    // the real failure even if failDeployment's DB write itself throws.
    const code = classifyDeployFailure(step, message).code;
    log(stepToBuildLogStep(step), "error", message, code);
    outcome = { status: "failed", errorStep: step, errorCode: code };
    await failDeployment(env, deploymentId, step, message);
  } finally {
    await persistDeployLog(env, input, {
      startedAt,
      lines: logLines,
      status: outcome.status,
      errorStep: outcome.errorStep,
      errorCode: outcome.errorCode,
    });
    // Reclaim R2 staging on BOTH success and failure — a failed deploy would
    // otherwise leave its (tens-of-MB) server-file objects behind forever.
    // Best-effort: this is terminal, so a delete error must not surface.
    await deleteStagedBundle(env, deploymentId);
  }
}

/** Map a server-side deploy stage name onto the shared BuildLogStep vocab. */
function stepToBuildLogStep(step: string): BuildLogStep {
  switch (step) {
    case "uploading":
      return "upload";
    case "provisioning":
      return "provision";
    case "deploying":
      return "activate";
    default:
      return "activate";
  }
}

/**
 * Persist the accumulated deploy-stage log so `creek deployments logs` can show
 * what the server did — not just the deployment row's one-line error.
 *
 * Best-effort and, crucially, no-clobber: the build_log row is keyed by
 * deploymentId, but the CLI and remote-builder also upload their own (richer,
 * build-stage) logs for the same deployment. storeBuildLogIfAbsent claims the
 * row atomically and only writes when nothing else has — i.e. GitHub-push
 * deploys and CLI deploys where the client already disconnected, which is
 * exactly the case B2 is about. Never throws.
 */
async function persistDeployLog(
  env: Env,
  input: DeployJobInput,
  opts: {
    startedAt: number;
    lines: BuildLogLine[];
    status: BuildLogStatus;
    errorStep: string | null;
    errorCode: string | null;
  },
): Promise<void> {
  if (!env.LOGS_BUCKET) return; // logs are optional infra
  try {
    const body = opts.lines.length
      ? opts.lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
      : "";
    // Atomic no-clobber: only writes if no client/remote-builder log already
    // owns this deployment (they carry the richer build-stage log).
    await storeBuildLogIfAbsent(env, {
      team: input.teamSlug,
      project: input.projectSlug,
      deploymentId: input.deploymentId,
      status: opts.status,
      startedAt: opts.startedAt,
      endedAt: Date.now(),
      body,
      errorCode: opts.errorCode,
      errorStep: opts.errorStep,
    });
  } catch {
    // Log persistence must never break or mask a deploy outcome.
  }
}

// --- Helpers ---

async function setDeploymentStatus(env: Env, deploymentId: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE deployment SET status = ?, updatedAt = ? WHERE id = ?")
    .bind(status, Date.now(), deploymentId)
    .run();
}

/**
 * Decode a base64 string to an ArrayBuffer. Writes into a pre-allocated typed
 * array with a tight index loop rather than `Uint8Array.from(atob(b64), fn)`,
 * which invokes a callback per byte — measurably slower across an asset-heavy
 * bundle's tens of MB.
 */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Decode a staged bundle's base64 `assets` into ArrayBuffers, freeing each
 * source base64 string from `bundle` as it is decoded so the parsed base64 and
 * the decoded buffers don't both sit in the 128MB Worker heap. Mutates `bundle`
 * (its `assets` values become ""); keys are preserved for the asset-count log.
 * Server files are handled separately by {@link resolveServerFiles}. Exported
 * for tests.
 */
export function decodeBundleAssets(bundle: StagedBundle): Record<string, ArrayBuffer> {
  const decodedClientAssets: Record<string, ArrayBuffer> = {};
  for (const path of Object.keys(bundle.assets)) {
    decodedClientAssets[path] = base64ToArrayBuffer(bundle.assets[path]);
    bundle.assets[path] = ""; // free the base64 for GC before the next decode
  }
  return decodedClientAssets;
}

/** R2 key prefix for a deployment's separately-staged binary server files. */
export function serverFileKey(deploymentId: string, name: string): string {
  return `bundles/${deploymentId}-server/${name}`;
}

/**
 * Validate a server-file name before it becomes part of an R2 key. Legit names
 * look like "worker.js" or "chunks/ssr_xxx.js" (slashes OK), never absolute,
 * `..`-relative, control-char, or absurdly long. Shared by the /serverfile
 * upload route AND the deploy job's read path — the /bundle handler doesn't
 * validate `serverFileNames`, so the job must not trust them blindly.
 */
export function isValidServerFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 512 &&
    !name.startsWith("/") &&
    !name.split("/").includes("..") &&
    ![...name].some((ch) => ch.charCodeAt(0) < 0x20)
  );
}

/**
 * Best-effort removal of a deployment's R2 staging: the bundle JSON plus every
 * separately-staged binary server file. Lists the server-file prefix rather than
 * needing the bundle, so it also reclaims staging for a job that was killed
 * (e.g. OOM) before it could clean up — the reaper calls this for reaped
 * deployments. Never throws (allSettled), so it can't fail the caller.
 */
export async function deleteStagedBundle(env: Env, deploymentId: string): Promise<void> {
  const keys = [`bundles/${deploymentId}.json`];
  try {
    const listed = await env.ASSETS.list({ prefix: `bundles/${deploymentId}-server/` });
    for (const obj of listed.objects) keys.push(obj.key);
  } catch {
    // Listing failed — still attempt the bundle JSON below.
  }
  await Promise.allSettled(keys.map((key) => env.ASSETS.delete(key)));
}

/**
 * Resolve a bundle's server files (worker.js + wasm) to ArrayBuffers.
 *
 * These are the memory-heavy part of a real Prisma/Next bundle (a large worker
 * plus a ~3.5MB compiler wasm). Inlining them as base64 in the bundle JSON
 * forces this 128MB Worker to hold the 2-byte base64 strings AND the decoded
 * buffers at once — the intermittent-OOM cause. So a current CLI stages each
 * server file as a separate BINARY R2 object and lists them in
 * `bundle.serverFileNames`; we read those as ArrayBuffers directly (no base64,
 * no JSON parse of the big blob). An older CLI still inlines `bundle.serverFiles`
 * as base64 — decode that in place, freeing each string as we go. Returns
 * undefined for a pure SPA; throws if the bundle declares a worker/SSR render
 * but staged no server files (which would otherwise deploy as a broken SPA).
 */
export async function resolveServerFiles(
  env: Env,
  deploymentId: string,
  bundle: StagedBundle,
): Promise<Record<string, ArrayBuffer> | undefined> {
  if (bundle.serverFileNames && bundle.serverFileNames.length > 0) {
    // Defensive: if a bundle also carries inline serverFiles (it shouldn't —
    // they're mutually exclusive), drop those large base64 strings so they don't
    // stay referenced and negate the memory savings this whole path exists for.
    if (bundle.serverFiles) {
      for (const path of Object.keys(bundle.serverFiles)) bundle.serverFiles[path] = "";
    }
    const out: Record<string, ArrayBuffer> = {};
    for (const name of bundle.serverFileNames) {
      // The /bundle handler doesn't validate serverFileNames, so guard here too.
      if (!isValidServerFileName(name)) throw new Error(`Invalid server file name: ${name}`);
      const obj = await env.ASSETS.get(serverFileKey(deploymentId, name));
      if (!obj) throw new Error(`Server file missing from staging: ${name}`);
      out[name] = await obj.arrayBuffer();
    }
    return out;
  }

  if (bundle.serverFiles && Object.keys(bundle.serverFiles).length > 0) {
    const out: Record<string, ArrayBuffer> = {};
    for (const path of Object.keys(bundle.serverFiles)) {
      out[path] = base64ToArrayBuffer(bundle.serverFiles[path]);
      bundle.serverFiles[path] = "";
    }
    return out;
  }

  // No server files. Correct for a pure SPA — but if the bundle declares a
  // worker/SSR render, missing server files would silently deploy as a static
  // SPA (a broken app). Fail loudly instead of falling through to that path.
  const renderMode = bundle.manifest?.renderMode;
  if (bundle.manifest?.hasWorker === true || renderMode === "ssr" || renderMode === "worker") {
    throw new Error(
      "Server files missing: bundle declares a worker/SSR render but staged no serverFileNames or serverFiles",
    );
  }
  return undefined;
}

/** How often to beat updatedAt during a long edge deploy. */
export const DEPLOY_HEARTBEAT_MS = 60_000;

/**
 * Touch updatedAt to signal the deploy is still progressing. Guarded on
 * status = 'deploying' so it never resurrects a row the reaper already failed
 * (avoids racing the stale-deploy sweep).
 */
async function touchDeployment(env: Env, deploymentId: string): Promise<void> {
  await env.DB.prepare("UPDATE deployment SET updatedAt = ? WHERE id = ? AND status = 'deploying'")
    .bind(Date.now(), deploymentId)
    .run();
}

/**
 * Run `fn` while beating updatedAt every DEPLOY_HEARTBEAT_MS, so the
 * stale-deploy reaper treats a slow-but-progressing deploy as alive. The
 * heartbeat stops as soon as `fn` settles (success or failure).
 */
export async function withDeployHeartbeat<T>(
  env: Env,
  deploymentId: string,
  fn: () => Promise<T>,
  intervalMs: number = DEPLOY_HEARTBEAT_MS,
): Promise<T> {
  let done = false;
  // Cancellable sleep: when fn settles we must wake the pending interval
  // immediately, otherwise `await beat` (and the deploy going active) would
  // block until the full interval elapses.
  let wake: () => void = () => {};
  const beat = (async () => {
    while (!done) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      if (done) break;
      try {
        await touchDeployment(env, deploymentId);
      } catch {
        // A failed heartbeat is non-fatal — the deploy itself is the work.
      }
    }
  })();
  try {
    return await fn();
  } finally {
    done = true;
    wake();
    await beat;
  }
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
