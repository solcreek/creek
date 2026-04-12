/**
 * Web Deploy — public routes (no auth required).
 *
 * POST /web-deploy          → trigger build + deploy to sandbox
 * GET  /web-deploy/:id      → poll build status
 *
 * These routes are called from creek.dev/new (browser) and are
 * rate-limited by IP. No login required — uses sandbox infrastructure.
 */

import { Hono } from "hono";
import type { Env } from "../../types.js";
import { buildAndDeploy, fetchCommitSha, updateStatus, hashIp, type DeployRequest } from "./build-and-deploy.js";

type AppEnv = { Bindings: Env };

export const webDeploy = new Hono<AppEnv>();

// POST /web-deploy — trigger build
webDeploy.post("/", async (c) => {
  // CSRF: only allow creek.dev origins
  const origin = c.req.header("origin");
  if (origin) {
    try {
      const url = new URL(origin);
      const allowed =
        url.hostname === "creek.dev" ||
        url.hostname.endsWith(".creek.dev") ||
        url.hostname === "localhost";
      if (!allowed) return c.json({ error: "forbidden" }, 403);
    } catch {
      return c.json({ error: "forbidden" }, 403);
    }
  }

  let body: DeployRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Validate
  if (body.type === "template") {
    if (!body.template || !/^[a-zA-Z0-9_-]+$/.test(body.template)) {
      return c.json({ error: "Invalid template name" }, 400);
    }
  } else if (body.type === "repo") {
    if (!body.repo) return c.json({ error: "repo is required" }, 400);
    try {
      const url = new URL(body.repo.startsWith("http") ? body.repo : `https://${body.repo}`);
      if (!["github.com", "gitlab.com", "bitbucket.org"].includes(url.hostname)) {
        return c.json({ error: "Only GitHub, GitLab, and Bitbucket repos supported" }, 400);
      }
    } catch {
      return c.json({ error: "Invalid repo URL" }, 400);
    }
  } else {
    return c.json({ error: "type must be 'template' or 'repo'" }, 400);
  }

  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";

  // --- Cache hit bypass ---
  // Resolve the commit SHA and check if remote-builder already has a
  // pre-built bundle. Cache hits bypass the rate limit entirely because
  // they consume no build resources — rate limiting exists to protect
  // container builds, not downstream sandbox deploys. Without this
  // bypass, a viral deploy button would rate-limit after 5 clicks from
  // the same IP (office NAT) even though 99% are instant cache hits.
  //
  // We check a lightweight "bundlemeta:" existence marker (~100 bytes)
  // rather than reading the full multi-MB bundle on every POST.
  let commitSha: string | null = null;
  let cacheHitPreflight = false;
  if (body.type === "repo" && body.repo) {
    const normalizedRepo = body.repo!.startsWith("http")
      ? body.repo!
      : `https://github.com/${body.repo}`;
    commitSha = await fetchCommitSha(normalizedRepo, body.branch || "main");
    console.log(`[web-deploy] SHA resolve: ${normalizedRepo} → ${commitSha ?? "null (cache will be skipped)"}`);

    if (commitSha) {
      try {
        const branch = body.branch || "main";
        const metaKey = `bundlemeta:${normalizedRepo}:${branch}:${commitSha}${body.path ? `:${body.path}` : ""}`;
        const meta = await c.env.BUILD_STATUS.get(metaKey);
        if (meta) {
          cacheHitPreflight = true;
          console.log(`[web-deploy] CACHE HIT preflight — bypassing rate limit`);
        }
      } catch {
        // Non-critical — fall through to rate limit
      }
    }
  }

  // Rate limit: 5/hr per IP — cache hits are exempt
  if (!cacheHitPreflight) {
    const rateLimitKey = `rate:${hashIp(ip)}`;
    const currentCount = parseInt((await c.env.BUILD_STATUS.get(rateLimitKey)) || "0");
    if (currentCount >= 5) {
      return c.json({
        error: "rate_limited",
        message: "You've used all 5 free builds this hour. Deploy a cached repo (any repo someone else deployed recently) or wait.",
        retryAfter: 3600,
      }, 429);
    }
    await c.env.BUILD_STATUS.put(rateLimitKey, String(currentCount + 1), { expirationTtl: 3600 });
  }

  // Generate build ID
  const buildId = crypto.randomUUID().slice(0, 12);

  // Store initial status + enqueue build
  await updateStatus(c.env, buildId, {
    status: "building",
    type: body.type,
    createdAt: new Date().toISOString(),
  });

  await buildAndDeploy(buildId, body, c.env, commitSha);

  return c.json({ buildId, statusUrl: `/web-deploy/${buildId}` }, 202);
});

// GET /web-deploy/list — aggregated deployments (KV in-flight + sandbox-db history)
webDeploy.get("/list", async (c) => {
  // 1. KV: in-flight builds
  const keys = await c.env.BUILD_STATUS.list({ prefix: "build:" });
  const kvBuilds = await Promise.all(
    keys.keys.map(async (key) => {
      const data = await c.env.BUILD_STATUS.get(key.name);
      if (!data) return null;
      const parsed = JSON.parse(data);
      return { ...parsed, source: "kv", environment: "sandbox", trigger: "web" };
    }),
  );

  // 2. Sandbox-db: recent deployments (via sandbox-api internal endpoint)
  let sandboxDeploys: any[] = [];
  try {
    const res = await fetch(`${c.env.SANDBOX_API_URL}/api/deployments/recent`, {
      headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET },
    });
    if (res.ok) {
      sandboxDeploys = (await res.json() as any[]).map((d) => ({ ...d, source: "db" }));
    }
  } catch {
    // sandbox-api unreachable — return KV data only
  }

  // 3. Merge + deduplicate (KV buildId may match sandbox deploymentId)
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const item of [...kvBuilds.filter(Boolean), ...sandboxDeploys]) {
    const id = item.buildId || item.deploymentId;
    if (id && !seen.has(id)) {
      seen.add(id);
      merged.push(item);
    }
  }

  // 4. Sort by time descending
  merged.sort((a, b) => (b.createdAt || b.updatedAt || "").localeCompare(a.createdAt || a.updatedAt || ""));

  return c.json(merged);
});

// GET /web-deploy/preflight — check if the repo@commit is already cached,
// so the UI can show "⚡ Turbo — instant deploy" before the user clicks.
// Public, unauthenticated, cheap (one GitHub API call + one KV read).
// Must be defined BEFORE /:buildId so Hono routes it correctly.
webDeploy.get("/preflight", async (c) => {
  const repo = c.req.query("repo");
  const branch = c.req.query("branch") || "main";
  const path = c.req.query("path");

  if (!repo) {
    return c.json({ cached: false, reason: "missing_repo" });
  }

  const normalizedRepo = repo.startsWith("http")
    ? repo
    : `https://github.com/${repo}`;

  try {
    const sha = await fetchCommitSha(normalizedRepo, branch);
    if (!sha) {
      // GitHub API failure or non-GitHub host — can't cache without SHA
      return c.json({ cached: false, reason: "no_sha" });
    }

    const metaKey = `bundlemeta:${normalizedRepo}:${branch}:${sha}${path ? `:${path}` : ""}`;
    const meta = await c.env.BUILD_STATUS.get(metaKey);

    if (meta) {
      try {
        const parsed = JSON.parse(meta) as { size?: number; cachedAt?: number };
        return c.json({
          cached: true,
          commitSha: sha,
          cachedAt: parsed.cachedAt,
          sizeKB: parsed.size ? Math.round(parsed.size / 1024) : undefined,
        });
      } catch {
        // Corrupt metadata — treat as uncached
      }
    }

    return c.json({ cached: false, commitSha: sha });
  } catch {
    return c.json({ cached: false, reason: "error" });
  }
});

// GET /web-deploy/:buildId — poll status
webDeploy.get("/:buildId", async (c) => {
  const buildId = c.req.param("buildId");
  const data = await c.env.BUILD_STATUS.get(`build:${buildId}`);
  if (!data) return c.json({ error: "Build not found" }, 404);
  return c.json(JSON.parse(data));
});
