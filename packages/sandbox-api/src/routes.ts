import { Hono } from "hono";
import type { Env } from "./types.js";
import { deployWithAssets, shortDeployId } from "@solcreek/deploy-core";
import { scanBundle } from "./scan.js";
import { verifyAgentToken } from "./agent-challenge.js";

type SandboxEnv = { Bindings: Env };

const routes = new Hono<SandboxEnv>();

// ---------------------------------------------------------------------------
// Tiered rate limits
// ---------------------------------------------------------------------------
// Tier 1: Verified agent (passed agent challenge) → 60/hr
// Tier 2: Human CLI (TTY detected, source = "cli") → 10/hr
// Tier 3: Unverified (no token, no TTY signal)     →  5/hr
// Demo deploys (source = "cli-demo") are exempt from rate limits.
// ---------------------------------------------------------------------------

type RateTier = "verified_agent" | "human_cli" | "unverified";

const RATE_LIMITS: Record<RateTier, number> = {
  verified_agent: 60,
  human_cli: 10,
  unverified: 5,
};

async function resolveRateTier(
  c: { req: { header: (name: string) => string | undefined } },
  env: Env,
  ipHash: string,
): Promise<RateTier> {
  // Check for agent token (Bearer crk_agent_...)
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer crk_agent_")) {
    const token = authHeader.slice("Bearer ".length);
    const payload = await verifyAgentToken(token, env.INTERNAL_SECRET, ipHash);
    if (payload) return "verified_agent";
    // Invalid/expired token falls through to lower tiers
  }

  // Check for TTY signal (CLI sends this header when running interactively)
  const ttyHeader = c.req.header("x-creek-tty");
  if (ttyHeader === "1" || ttyHeader === "true") return "human_cli";

  return "unverified";
}

// --- Deploy a sandbox ---

routes.post("/deploy", async (c) => {
  const env = c.env;
  const ttlMinutes = parseInt(env.SANDBOX_TTL_MINUTES || "60", 10);
  const now = Date.now();
  const expiresAt = now + ttlMinutes * 60 * 1000;

  // Resolve client IP — trust X-Forwarded-For only from internal services
  const internalSecret = c.req.header("x-internal-secret");
  const isTrustedInternal = internalSecret && env.INTERNAL_SECRET && internalSecret === env.INTERNAL_SECRET;
  const ip = isTrustedInternal
    ? (c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown")
    : (c.req.header("cf-connecting-ip") ?? "unknown");
  const ipHash = await hashIp(ip, env);

  // Parse bundle
  let body: {
    manifest?: {
      assets?: string[];
      hasWorker?: boolean;
      entrypoint?: string | null;
      renderMode?: "spa" | "ssr" | "static";
    };
    assets: Record<string, string>;
    serverFiles?: Record<string, string>;
    framework?: string;
    templateId?: string;
    source?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "validation", message: "Invalid or missing JSON body" }, 400);
  }

  if (!body.assets || Object.keys(body.assets).length === 0) {
    return c.json({ error: "validation", message: "At least one asset is required" }, 400);
  }

  // Derive manifest defaults from assets if not provided
  const assetPaths = Object.keys(body.assets);
  const manifest = {
    assets: body.manifest?.assets ?? assetPaths,
    hasWorker: body.manifest?.hasWorker ?? false,
    entrypoint: body.manifest?.entrypoint ?? null,
    renderMode: body.manifest?.renderMode ?? "spa" as const,
  };

  const bundleSize = JSON.stringify(body).length;
  if (bundleSize > 50 * 1024 * 1024) {
    return c.json({ error: "validation", message: "Bundle too large. Max 50MB." }, 400);
  }

  // Tiered rate limiting
  // - Demo deploys (source = "cli-demo") are exempt.
  // - Trusted internal calls (remote-builder via X-Internal-Secret) are
  //   exempt because rate limiting was already applied at the control-plane
  //   level with the real user IP. Without this exemption, ALL web deploys
  //   share a single rate limit bucket because remote-builder doesn't
  //   forward the original user IP → ipHash = hash("unknown").
  const isDemo = body.source === "cli-demo";
  const isRateLimitExempt = isDemo || isTrustedInternal;
  const tier = await resolveRateTier(c, env, ipHash);
  const RATE_LIMIT = RATE_LIMITS[tier];
  const RATE_WINDOW = 3600_000; // 1 hour
  const windowStart = now - RATE_WINDOW;
  let remaining = RATE_LIMIT;
  let resetAt = now + RATE_WINDOW;

  if (!isRateLimitExempt) {
    const rateInfo = await env.DB.prepare(
      "SELECT COUNT(*) as count, MIN(createdAt) as oldest FROM deployments WHERE ipHash = ? AND source != 'cli-demo' AND createdAt > ?",
    )
      .bind(ipHash, windowStart)
      .first<{ count: number; oldest: number | null }>();

    const used = rateInfo?.count ?? 0;
    remaining = Math.max(0, RATE_LIMIT - used);
    resetAt = rateInfo?.oldest ? rateInfo.oldest + RATE_WINDOW : now + RATE_WINDOW;

    if (used >= RATE_LIMIT) {
      const retryMin = Math.max(1, Math.ceil((resetAt - now) / 60_000));
      const upgradeHint = tier === "unverified"
        ? "Verify as an agent for higher limits: POST /api/sandbox/agent-verify/start"
        : tier === "human_cli"
          ? "Create a free account for unlimited deploys: npx creek login"
          : "Rate limit reached even for verified agents. Please wait.";
      return c.json(
        {
          error: "rate_limited",
          message: `Sandbox deploy limit reached (${RATE_LIMIT}/hr for ${tier}). Resets in ~${retryMin} min.`,
          hint: upgradeHint,
          tier,
          retryAfter: Math.ceil((resetAt - now) / 1000),
          limit: RATE_LIMIT,
          remaining: 0,
          reset: Math.ceil(resetAt / 1000),
        },
        429,
        {
          "Retry-After": String(Math.ceil((resetAt - now) / 1000)),
          "X-RateLimit-Limit": String(RATE_LIMIT),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.ceil(resetAt / 1000)),
          "X-RateLimit-Tier": tier,
        },
      );
    }
  }

  // Static content scan (agent-friendly, no CAPTCHA)
  const scanResult = scanBundle(body.assets);
  if (!scanResult.ok) {
    return c.json(
      { error: scanResult.reason, message: scanResult.detail ?? "Content policy violation" },
      400,
    );
  }

  // Generate sandbox ID and preview host
  const sandboxId = crypto.randomUUID().slice(0, 8);
  const previewHost = `${sandboxId}.${env.SANDBOX_DOMAIN}`;

  // Capture legal / audit metadata from request headers
  const country = c.req.header("cf-ipcountry") ?? null;
  const userAgent = c.req.header("user-agent") ?? null;
  const tosVersion = c.req.header("x-creek-tos-version") ?? null;
  const tosAcceptedAt = c.req.header("x-creek-tos-accepted-at") ?? null;

  // Content fingerprint for post-incident forensics
  const bundleJson = JSON.stringify(body);
  const contentHashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bundleJson));
  const contentHash = [...new Uint8Array(contentHashBuf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

  // Insert sandbox record
  const assetCount = assetPaths.length;
  await env.DB.prepare(
    `INSERT INTO deployments (id, templateId, framework, status, previewHost, source, renderMode, assetCount, ipHash, createdAt, expiresAt, country, userAgent, tosVersion, tosAcceptedAt, contentHash)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      sandboxId,
      body.templateId ?? null,
      body.framework ?? null,
      previewHost,
      body.source ?? "cli",
      manifest.renderMode,
      assetCount,
      ipHash,
      now,
      expiresAt,
      country,
      userAgent,
      tosVersion,
      tosAcceptedAt,
      contentHash,
    )
    .run();

  // Store raw IP in separate table (30-day retention for legal compliance)
  await env.DB.prepare(
    "INSERT INTO sandbox_ip_log (sandboxId, rawIp, createdAt) VALUES (?, ?, ?)",
  )
    .bind(sandboxId, ip, now)
    .run();

  // Stage bundle to R2
  const bundleKey = `bundles/${sandboxId}.json`;
  await env.ASSETS.put(bundleKey, bundleJson);

  // Deploy async via waitUntil
  c.executionCtx.waitUntil(
    runSandboxDeploy(env, sandboxId, previewHost, { ...body, manifest }),
  );

  return c.json(
    {
      sandboxId,
      status: "queued",
      statusUrl: `${new URL(c.req.url).origin}/api/sandbox/${sandboxId}/status`,
      previewUrl: `https://${previewHost}`,
      expiresAt: new Date(expiresAt).toISOString(),
      tier,
    },
    202,
    {
      "X-RateLimit-Limit": String(RATE_LIMIT),
      "X-RateLimit-Remaining": String(remaining - 1), // this deploy counts
      "X-RateLimit-Reset": String(Math.ceil(resetAt / 1000)),
      "X-RateLimit-Tier": tier,
    },
  );
});

// --- Get sandbox status ---

routes.get("/:id/status", async (c) => {
  const sandboxId = c.req.param("id");

  const sandbox = await c.env.DB.prepare(
    "SELECT * FROM deployments WHERE id = ?",
  )
    .bind(sandboxId)
    .first<{
      id: string;
      templateId: string | null;
      framework: string | null;
      status: string;
      previewHost: string;
      source: string;
      renderMode: string | null;
      assetCount: number | null;
      failedStep: string | null;
      errorMessage: string | null;
      claimStatus: string;
      createdAt: number;
      expiresAt: number;
      activatedAt: number | null;
      deployDurationMs: number | null;
    }>();

  if (!sandbox) {
    return c.json({ error: "not_found", message: "Sandbox not found" }, 404);
  }

  const now = Date.now();
  const isExpired = sandbox.status === "active" && now > sandbox.expiresAt;

  return c.json({
    sandboxId: sandbox.id,
    status: isExpired ? "expired" : sandbox.status,
    templateId: sandbox.templateId,
    framework: sandbox.framework,
    source: sandbox.source,
    renderMode: sandbox.renderMode ?? "spa",
    assetCount: sandbox.assetCount ?? 0,
    previewUrl: `https://${sandbox.previewHost}`,
    deployDurationMs: sandbox.deployDurationMs,
    createdAt: new Date(sandbox.createdAt).toISOString(),
    expiresAt: new Date(sandbox.expiresAt).toISOString(),
    expiresInSeconds: Math.max(0, Math.floor((sandbox.expiresAt - now) / 1000)),
    claimable: sandbox.claimStatus === "unclaimed" && !isExpired,
    failedStep: sandbox.failedStep,
    errorMessage: sandbox.errorMessage,
  });
});

// --- Report abuse ---

routes.post("/:id/report", async (c) => {
  const sandboxId = c.req.param("id");
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}));

  const sandbox = await c.env.DB.prepare(
    "SELECT id, status FROM deployments WHERE id = ?",
  )
    .bind(sandboxId)
    .first<{ id: string; status: string }>();

  if (!sandbox) {
    return c.json({ error: "not_found" }, 404);
  }

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const ipHash = await hashIp(ip, c.env);

  await c.env.DB.prepare(
    `INSERT INTO sandbox_abuse_report (id, sandboxId, reason, ipHash, createdAt)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID().slice(0, 8), sandboxId, (body as any).reason ?? "unspecified", ipHash, Date.now())
    .run();

  // Auto-ban: if a sandbox accumulates >= 2 reports, mark it as blocked
  if (sandbox.status === "active") {
    const reportCount = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM sandbox_abuse_report WHERE sandboxId = ?",
    )
      .bind(sandboxId)
      .first<{ count: number }>();

    if (reportCount && reportCount.count >= 2) {
      await c.env.DB.prepare(
        "UPDATE deployments SET status = 'blocked' WHERE id = ? AND status = 'active'",
      )
        .bind(sandboxId)
        .run();
    }
  }

  return c.json({ ok: true, message: "Report received. Thank you." });
});

// --- Delete sandbox early ---

routes.delete("/:id", async (c) => {
  const sandboxId = c.req.param("id");
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const ipHash = await hashIp(ip, c.env);

  const sandbox = await c.env.DB.prepare(
    "SELECT id, ipHash, status FROM deployments WHERE id = ?",
  )
    .bind(sandboxId)
    .first<{ id: string; ipHash: string | null; status: string }>();

  if (!sandbox) {
    return c.json({ error: "not_found", message: "Sandbox not found" }, 404);
  }

  // Only the creator (same IP hash) can delete
  if (sandbox.ipHash !== ipHash) {
    return c.json({ error: "forbidden", message: "Only the sandbox creator can delete it" }, 403);
  }

  if (sandbox.status === "expired" || sandbox.status === "cleaned_up") {
    return c.json({ error: "already_expired", message: "Sandbox is already expired" }, 410);
  }

  // Mark as expired so cleanup cron will handle WfP script deletion
  await c.env.DB.prepare(
    "UPDATE deployments SET status = 'expired', expiresAt = ? WHERE id = ?",
  )
    .bind(Date.now(), sandboxId)
    .run();

  // Delete staged bundle if still in R2
  await c.env.ASSETS.delete(`bundles/${sandboxId}.json`);

  return c.json({ ok: true, message: "Sandbox deleted" });
});

// --- Claim sandbox ---

routes.post("/:id/claim", async (c) => {
  const sandboxId = c.req.param("id");
  const body = await c.req.json<{ projectId?: string }>().catch(() => ({}));

  const sandbox = await c.env.DB.prepare(
    "SELECT id, claimStatus FROM deployments WHERE id = ?",
  )
    .bind(sandboxId)
    .first<{ id: string; claimStatus: string }>();

  if (!sandbox) {
    return c.json({ error: "not_found" }, 404);
  }

  if (sandbox.claimStatus !== "unclaimed") {
    return c.json({ error: "already_claimed", message: "This sandbox has already been claimed." }, 400);
  }

  await c.env.DB.prepare(
    "UPDATE deployments SET claimStatus = 'claimed', claimedProjectId = ? WHERE id = ?",
  )
    .bind((body as any).projectId ?? null, sandboxId)
    .run();

  return c.json({ ok: true });
});

// --- Async deploy job ---

async function runSandboxDeploy(
  env: Env,
  sandboxId: string,
  previewHost: string,
  bundle: {
    manifest: { assets: string[]; hasWorker: boolean; entrypoint: string | null; renderMode: string };
    assets: Record<string, string>;
    serverFiles?: Record<string, string>;
    framework?: string;
    // Optional cache-coherent team ID. When present, used as the hash
    // salt instead of the sandbox-specific ID. This lets CF Static Assets
    // dedup identical content across sandboxes built from the same
    // repo@commit — the second deploy uploads 0 bytes because all asset
    // hashes already exist in the dispatch namespace. The sandboxes are
    // still FULLY ISOLATED (own script name, own URL, own data) — only
    // the underlying asset storage is shared.
    cacheTeamId?: string;
  },
) {
  try {
    await env.DB.prepare(
      "UPDATE deployments SET status = 'deploying', activatedAt = ? WHERE id = ?",
    )
      .bind(Date.now(), sandboxId)
      .run();

    // Decode assets
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

    // "static" mode → deploy as "spa" but without index.html fallback embedding
    // (deploy-core handles this: "spa" embeds fallback, "ssr" does not)
    // For static MPA, we use "spa" since WfP serves exact asset paths — the SPA
    // fallback only triggers for paths that don't match any asset.
    const renderMode = bundle.manifest.renderMode === "ssr" ? "ssr" : "spa" as const;

    // Deploy to WfP sandbox namespace — single script (no branch/production variants)
    // When cacheTeamId is set (cache-hit deploy from remote-builder), use
    // it as the hash salt so CF's global asset dedup recognises identical
    // content from a prior sandbox. 0 bytes uploaded on cache hit → fast.
    const teamId = bundle.cacheTeamId ?? sandboxId;
    await deployWithAssets(
      env,
      sandboxId,  // projectSlug = sandboxId (unique per sandbox — isolation)
      "sandbox",  // teamSlug = "sandbox"
      sandboxId,  // deploymentId = sandboxId
      {
        clientAssets,
        serverFiles,
        renderMode,
        teamId,                // cache-coherent OR sandbox-unique salt
        teamSlug: "sandbox",
        projectSlug: sandboxId,
        plan: "sandbox",
        bindings: [], // no per-tenant resources
      },
    );

    const deployDuration = Date.now() - (await env.DB.prepare(
      "SELECT createdAt FROM deployments WHERE id = ?",
    ).bind(sandboxId).first<{ createdAt: number }>())!.createdAt;

    await env.DB.prepare(
      "UPDATE deployments SET status = 'active', deployDurationMs = ? WHERE id = ?",
    )
      .bind(deployDuration, sandboxId)
      .run();

    // Cleanup staged bundle
    await env.ASSETS.delete(`bundles/${sandboxId}.json`);
  } catch (err) {
    await env.DB.prepare(
      "UPDATE deployments SET status = 'failed', failedStep = 'deploying', errorMessage = ? WHERE id = ?",
    )
      .bind(err instanceof Error ? err.message : String(err), sandboxId)
      .run();
  }
}

// --- Helpers ---

async function hashIp(ip: string, env: Env): Promise<string> {
  const salt = env.IP_HASH_SALT || "creek-sandbox-salt";
  const data = new TextEncoder().encode(ip + salt);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export { routes };
