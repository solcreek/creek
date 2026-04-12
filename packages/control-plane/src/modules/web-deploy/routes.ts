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
import { buildAndDeploy, buildCacheKey, updateStatus, hashIp, type DeployRequest } from "./build-and-deploy.js";

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

  // Rate limit: 3/hr per IP (cache hits don't count — checked below)
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";

  // --- Build cache: if a recent sandbox of the same repo+branch+path
  // is still alive, skip the entire build pipeline and return instantly.
  // This is Phase 0 of the L4 cache layer — keyed by repo URL + branch,
  // not commit SHA (Phase 1 will add commit-level precision). The KV
  // entry lives as long as the sandbox (~55 min) so the same deploy
  // button link resolves instantly for all followers who click within
  // the sandbox window.
  if (body.type === "repo" && body.repo) {
    const normalizedRepo = body.repo.startsWith("http")
      ? body.repo
      : `https://github.com/${body.repo}`;
    const cacheKey = buildCacheKey(normalizedRepo, body.branch, body.path);
    const cached = await c.env.BUILD_STATUS.get(cacheKey);
    if (cached) {
      try {
        const hit = JSON.parse(cached) as {
          sandboxId: string;
          previewUrl: string;
          expiresAt: string;
        };
        // Only serve cache hit if sandbox has > 5 min remaining — don't
        // hand users a link that expires before they finish looking.
        const remaining = new Date(hit.expiresAt).getTime() - Date.now();
        if (remaining > 5 * 60 * 1000) {
          // Pre-populate a new buildId with terminal "active" status so
          // the client's first poll resolves immediately. Rate limit is
          // NOT consumed (no build resources used).
          const buildId = crypto.randomUUID().slice(0, 12);
          await updateStatus(c.env, buildId, {
            status: "active",
            sandboxId: hit.sandboxId,
            previewUrl: hit.previewUrl,
            expiresAt: hit.expiresAt,
            cacheHit: true,
            createdAt: new Date().toISOString(),
          });
          return c.json({ buildId, statusUrl: `/web-deploy/${buildId}` }, 202);
        }
      } catch {
        // Corrupt cache entry — fall through to normal build
      }
    }
  }

  // Rate limit: 5/hr per IP
  const rateLimitKey = `rate:${hashIp(ip)}`;
  const currentCount = parseInt((await c.env.BUILD_STATUS.get(rateLimitKey)) || "0");
  if (currentCount >= 5) {
    return c.json({
      error: "rate_limited",
      message: "You've used all 5 free deploys this hour.",
      retryAfter: 3600,
    }, 429);
  }
  await c.env.BUILD_STATUS.put(rateLimitKey, String(currentCount + 1), { expirationTtl: 3600 });

  // Generate build ID
  const buildId = crypto.randomUUID().slice(0, 12);

  // Store initial status + enqueue build
  await updateStatus(c.env, buildId, {
    status: "building",
    type: body.type,
    createdAt: new Date().toISOString(),
  });

  await buildAndDeploy(buildId, body, c.env);

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

// GET /web-deploy/:buildId — poll status
webDeploy.get("/:buildId", async (c) => {
  const buildId = c.req.param("buildId");
  const data = await c.env.BUILD_STATUS.get(`build:${buildId}`);
  if (!data) return c.json({ error: "Build not found" }, 404);
  return c.json(JSON.parse(data));
});
