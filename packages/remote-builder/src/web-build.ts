/**
 * Web-build pipeline: build template/repo → validate → deploy to sandbox → update KV.
 *
 * Runs as a Queue consumer in remote-builder, so it has no waitUntil time
 * limit. Writes status updates directly to BUILD_STATUS KV.
 *
 * Build output caching: when `commitSha` is present in the queue message,
 * the built bundle JSON is cached in KV under a composite key. Subsequent
 * deploys of the same repo+branch+sha skip the entire build pipeline and
 * re-POST the cached bundle to sandbox-api, which creates a FRESH isolated
 * sandbox. From outside, every deploy looks identical — same endpoint, same
 * response shape — the caching mechanism is purely internal.
 */

interface WebBuildMessage {
  buildId: string;
  repoUrl: string;
  path?: string;
  branch?: string;
  commitSha?: string;
  templateData?: Record<string, unknown>;
}

interface WebBuildEnv {
  BUILD_STATUS: KVNamespace;
  SANDBOX_API_URL: string;
  INTERNAL_SECRET?: string;
}

/** KV size limit for cached bundles (bytes). KV max is 25 MiB. */
const MAX_CACHE_SIZE = 24 * 1024 * 1024; // 24 MiB with safety margin

/**
 * Build a KV cache key for a repo deploy. Returns null if the message
 * doesn't carry a commitSha (templates, private repos where SHA
 * resolution failed).
 */
function bundleCacheKey(msg: WebBuildMessage): string | null {
  if (!msg.commitSha) return null;
  const parts = ["bundlecache", msg.repoUrl, msg.branch || "main", msg.commitSha];
  if (msg.path) parts.push(msg.path);
  return parts.join(":");
}

export async function handleWebBuild(
  message: WebBuildMessage,
  env: WebBuildEnv,
  buildFn: (req: { repoUrl: string; path?: string; branch?: string; templateData?: Record<string, unknown> }) => Promise<any>,
): Promise<void> {
  const { buildId } = message;
  const cacheKey = bundleCacheKey(message);

  // ------------------------------------------------------------------
  // 1. Try cache — read cached bundle if available
  // ------------------------------------------------------------------
  let bundleJson: string | null = null;
  let cacheHit = false;

  if (cacheKey) {
    try {
      const cached = await env.BUILD_STATUS.get(cacheKey);
      if (cached) {
        bundleJson = cached;
        cacheHit = true;
        console.log(`[build-cache] HIT ${cacheKey.slice(0, 80)} (${(cached.length / 1024).toFixed(0)} KB)`);
      } else {
        console.log(`[build-cache] MISS ${cacheKey.slice(0, 80)}`);
      }
    } catch (err) {
      console.error(`[build-cache] READ ERROR ${cacheKey.slice(0, 80)}:`, err);
    }
  } else {
    console.log(`[build-cache] SKIP (no commitSha in message)`);
  }

  // ------------------------------------------------------------------
  // 2. Build (only on cache miss)
  // ------------------------------------------------------------------
  if (!bundleJson) {
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

    // Validate bundle
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

    bundleJson = JSON.stringify({
      assets: buildResult.bundle.assets,
      serverFiles: buildResult.bundle.serverFiles,
      manifest: buildResult.bundle.manifest,
      framework: buildResult.config?.framework,
      source: "web",
      // Cache-coherent team ID for CF Static Assets dedup. When a
      // second sandbox deploys the same repo@commit, the hashes match
      // because the salt is the same → CF returns "0 buckets to upload"
      // → asset upload step is instant. Each sandbox still gets its OWN
      // script name / URL / data — only asset storage is shared.
      cacheTeamId: cacheTeamId(),
      // Bundle-declared compat — propagated to sandbox-api so the
      // deployed Worker gets the same compat envelope the user asked
      // for. Astro+@astrojs/cloudflare needs `nodejs_compat` + a
      // recent date to resolve `node:fs` imports; hardcoding our
      // default dropped that on the floor, producing 10021 errors.
      compatibilityDate: buildResult.bundle.compatibilityDate,
      compatibilityFlags: buildResult.bundle.compatibilityFlags,
      // Post-deploy UI hint (admin path, setup warnings) derived
      // from framework detection. Propagated verbatim to sandbox-api
      // and surfaced on the deploy-success page.
      hint: buildResult.bundle.hint,
      // Binding requirements from the user's wrangler.jsonc /
      // creek.toml. Sandbox-api uses these to provision ephemeral
      // D1/R2/KV so CMS-class templates (EmDash etc.) can actually
      // resolve their env.DB / env.MEDIA bindings at runtime.
      bindings: buildResult.bundle.bindings,
    });
  }

  function cacheTeamId(): string | undefined {
    if (!message.commitSha) return undefined;
    // Deterministic per repo+commit — all sandboxes of the same content
    // produce identical asset hashes and benefit from CF's global dedup.
    return `cache-${message.repoUrl.replace(/[^a-zA-Z0-9]/g, "").slice(-20)}-${message.commitSha}`;
  }

  // Extract the deploy hint from the bundle so we can surface it in
  // status updates the UI polls. Works for both fresh builds (just
  // written) and cache hits (re-read from cached bundleJson).
  let deployHint: unknown;
  try {
    deployHint = JSON.parse(bundleJson).hint;
  } catch {
    // bundleJson parse errors are handled elsewhere
  }

  // ------------------------------------------------------------------
  // 3. Deploy to sandbox (always — fresh sandbox per deploy)
  // ------------------------------------------------------------------
  await updateKV(env, buildId, {
    status: "deploying",
    ...(cacheHit ? { cacheHit: true } : {}),
  });

  let sandboxRes: Response;
  try {
    sandboxRes = await fetch(`${env.SANDBOX_API_URL}/api/sandbox/deploy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.INTERNAL_SECRET ? { "X-Internal-Secret": env.INTERNAL_SECRET } : {}),
      },
      body: bundleJson,
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
    const err = await sandboxRes.text().catch(() => "Deploy rejected");
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
    ...(deployHint ? { hint: deployHint } : {}),
  });

  // If sandbox is already active (immediate deploy), write cache + done
  if (sandbox.status === "active") {
    await writeBundleCache(env, cacheKey, cacheHit, bundleJson, sandbox.expiresAt);
    return;
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
        ...(deployHint ? { hint: deployHint } : {}),
      });
      await writeBundleCache(env, cacheKey, cacheHit, bundleJson, sandbox.expiresAt);
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
 * Write the bundle JSON to KV as a cache entry. Non-critical — if write
 * fails (bundle too large, KV error), the next deploy just rebuilds.
 */
async function writeBundleCache(
  env: Pick<WebBuildEnv, "BUILD_STATUS">,
  cacheKey: string | null,
  alreadyCached: boolean,
  bundleJson: string | null,
  expiresAt: string,
): Promise<void> {
  if (!cacheKey || alreadyCached || !bundleJson) return;

  const sizeKB = (bundleJson.length / 1024).toFixed(0);
  if (bundleJson.length > MAX_CACHE_SIZE) {
    console.log(`[build-cache] WRITE SKIP ${cacheKey.slice(0, 80)} — ${sizeKB} KB exceeds ${(MAX_CACHE_SIZE / 1024 / 1024).toFixed(0)} MiB cap`);
    return;
  }

  try {
    // Cache TTL is long because the key includes the commit SHA —
    // a specific commit's build output is IMMUTABLE and never goes
    // stale. Freshness is guaranteed by the control-plane's
    // fetchCommitSha() which always resolves the latest SHA from
    // GitHub before looking up the cache. A new push to the branch
    // produces a new SHA → new cache key → miss → rebuild.
    //
    // 7 days covers the typical deploy-button viral lifecycle (peak
    // traffic in the first few days). KV auto-evicts after TTL,
    // keeping storage bounded. Cost: ~100 repos × 2MB ≈ $0.10/month.
    const ttl = 7 * 24 * 60 * 60; // 7 days
    await env.BUILD_STATUS.put(cacheKey, bundleJson, { expirationTtl: ttl });
    // Also write a lightweight existence marker so control-plane can
    // check cache status without reading the full bundle. Used to
    // decide whether to consume rate limit before enqueueing.
    const metaKey = cacheKey.replace(/^bundlecache:/, "bundlemeta:");
    await env.BUILD_STATUS.put(
      metaKey,
      JSON.stringify({ size: bundleJson.length, cachedAt: Date.now() }),
      { expirationTtl: ttl },
    );
    console.log(`[build-cache] WRITE OK ${cacheKey.slice(0, 80)} — ${sizeKB} KB, TTL ${ttl}s`);
  } catch (err) {
    console.error(`[build-cache] WRITE ERROR ${cacheKey.slice(0, 80)} — ${sizeKB} KB:`, err);
  }
}
