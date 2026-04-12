/**
 * Web-build pipeline: build template/repo → validate → deploy to sandbox → update KV.
 *
 * Runs as a Queue consumer in remote-builder, so it has no waitUntil time
 * limit. Writes status updates directly to BUILD_STATUS KV.
 */

interface WebBuildMessage {
  buildId: string;
  repoUrl: string;
  path?: string;
  branch?: string;
  templateData?: Record<string, unknown>;
}

interface WebBuildEnv {
  BUILD_STATUS: KVNamespace;
  SANDBOX_API_URL: string;
  INTERNAL_SECRET?: string;
}

export async function handleWebBuild(
  message: WebBuildMessage,
  env: WebBuildEnv,
  buildFn: (req: { repoUrl: string; path?: string; branch?: string; templateData?: Record<string, unknown> }) => Promise<any>,
): Promise<void> {
  const { buildId } = message;

  // --- Build ---
  let buildResult: any;
  try {
    buildResult = await buildFn({
      repoUrl: message.repoUrl,
      path: message.path,
      branch: message.branch,
      templateData: message.templateData,
    });
  } catch (err) {
    await updateKV(env, buildId, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      failedStep: "build",
    });
    return;
  }

  if (!buildResult.success) {
    await updateKV(env, buildId, {
      status: "failed",
      error: buildResult.message || buildResult.error || "Build failed",
      failedStep: "build",
    });
    return;
  }

  // --- Validate bundle ---
  const assets = buildResult.bundle?.assets;
  if (!assets || Object.keys(assets).length === 0) {
    const hasWorker = buildResult.bundle?.serverFiles && Object.keys(buildResult.bundle.serverFiles).length > 0;
    await updateKV(env, buildId, {
      status: "failed",
      error: hasWorker
        ? "Worker projects require authenticated deployment. Use `creek deploy` with a Creek account."
        : "Build produced no output files. Check your build command and output directory.",
      failedStep: "build",
    });
    return;
  }

  // --- Deploy to sandbox ---
  await updateKV(env, buildId, { status: "deploying" });

  let sandboxRes: Response;
  try {
    sandboxRes = await fetch(`${env.SANDBOX_API_URL}/api/sandbox/deploy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.INTERNAL_SECRET ? { "X-Internal-Secret": env.INTERNAL_SECRET } : {}),
      },
      body: JSON.stringify({
        assets: buildResult.bundle.assets,
        serverFiles: buildResult.bundle.serverFiles,
        manifest: buildResult.bundle.manifest,
        framework: buildResult.config?.framework,
        source: "web",
      }),
    });
  } catch (err) {
    await updateKV(env, buildId, {
      status: "failed",
      error: `Sandbox API unreachable: ${err instanceof Error ? err.message : String(err)}`,
      failedStep: "deploy",
    });
    return;
  }

  if (!sandboxRes.ok) {
    const err = await sandboxRes.text().catch(() => "");
    await updateKV(env, buildId, {
      status: "failed",
      error: `Deploy failed: ${err.slice(0, 200)}`,
      failedStep: "deploy",
    });
    return;
  }

  const sandbox = (await sandboxRes.json()) as any;

  // Write intermediate status with sandbox info
  await updateKV(env, buildId, {
    status: sandbox.status === "active" ? "active" : "deploying",
    sandboxId: sandbox.sandboxId,
    previewUrl: sandbox.previewUrl,
    expiresAt: sandbox.expiresAt,
    sandboxStatusUrl: sandbox.statusUrl,
  });

  // If sandbox is already active (immediate deploy), write cache now
  if (sandbox.status === "active") {
    await writeBuildCache(env, message, {
      sandboxId: sandbox.sandboxId,
      previewUrl: sandbox.previewUrl,
      expiresAt: sandbox.expiresAt,
    });
  }

  // If not yet active, poll until terminal state.
  // Queue consumer has no time limit — safe to poll here.
  if (sandbox.status !== "active" && sandbox.status !== "failed" && sandbox.statusUrl) {
    let finalStatus = sandbox;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const statusRes = await fetch(sandbox.statusUrl);
        if (statusRes.ok) {
          finalStatus = await statusRes.json();
          if (finalStatus.status === "active" || finalStatus.status === "failed") break;
        }
      } catch {
        // Network hiccup — retry
      }
    }

    if (finalStatus.status === "active") {
      await updateKV(env, buildId, {
        status: "active",
        sandboxId: sandbox.sandboxId,
        previewUrl: sandbox.previewUrl,
        expiresAt: sandbox.expiresAt,
      });
      // Write build cache so subsequent deploys of the same
      // repo+branch+path skip the entire build pipeline.
      // KV TTL matches sandbox remaining lifetime — cache
      // auto-expires when the sandbox it points to does.
      // Cache key matches the one checked in control-plane's
      // POST /web-deploy route (buildCacheKey in build-and-deploy.ts).
      await writeBuildCache(env, message, {
        sandboxId: sandbox.sandboxId,
        previewUrl: sandbox.previewUrl,
        expiresAt: sandbox.expiresAt,
      });
    } else if (finalStatus.status === "failed") {
      await updateKV(env, buildId, {
        status: "failed",
        error: finalStatus.errorMessage || "Sandbox deploy failed",
        failedStep: "deploy",
      });
    }
    // If still not terminal after 60 polls (2 min), status stays "deploying"
    // with sandboxStatusUrl for client fallback
  }
}

async function updateKV(
  env: Pick<WebBuildEnv, "BUILD_STATUS">,
  buildId: string,
  data: Record<string, unknown>,
) {
  await env.BUILD_STATUS.put(
    `build:${buildId}`,
    JSON.stringify({ buildId, ...data, updatedAt: new Date().toISOString() }),
    { expirationTtl: 3600 },
  );
}

/**
 * Write a build cache entry so subsequent web-deploy requests for
 * the same repo+branch+path skip the entire build pipeline.
 *
 * Cache key shape matches `buildCacheKey()` in the control-plane's
 * web-deploy module (packages/control-plane/src/modules/web-deploy/
 * build-and-deploy.ts). KV TTL is set to the sandbox's remaining
 * lifetime so the cache self-cleans when the sandbox expires.
 */
async function writeBuildCache(
  env: Pick<WebBuildEnv, "BUILD_STATUS">,
  message: WebBuildMessage,
  sandbox: { sandboxId: string; previewUrl: string; expiresAt: string },
): Promise<void> {
  try {
    const branch = message.branch || "main";
    const parts = ["webcache", "repo", message.repoUrl, branch];
    if (message.path) parts.push(message.path);
    const cacheKey = parts.join(":");

    const remainingMs = new Date(sandbox.expiresAt).getTime() - Date.now();
    const ttlSeconds = Math.max(60, Math.floor(remainingMs / 1000));

    await env.BUILD_STATUS.put(
      cacheKey,
      JSON.stringify({
        sandboxId: sandbox.sandboxId,
        previewUrl: sandbox.previewUrl,
        expiresAt: sandbox.expiresAt,
      }),
      { expirationTtl: ttlSeconds },
    );
  } catch {
    // Cache write failure is not critical — next deploy just rebuilds
  }
}
