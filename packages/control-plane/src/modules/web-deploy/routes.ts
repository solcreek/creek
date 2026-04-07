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
import { buildAndDeploy, updateStatus, hashIp, type DeployRequest } from "./build-and-deploy.js";

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

  // Rate limit: 3/hr per IP
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
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

// GET /web-deploy/list — list recent builds (authenticated, for dashboard)
webDeploy.get("/list", async (c) => {
  const keys = await c.env.BUILD_STATUS.list({ prefix: "build:" });
  const builds = await Promise.all(
    keys.keys.map(async (key) => {
      const data = await c.env.BUILD_STATUS.get(key.name);
      return data ? JSON.parse(data) : null;
    }),
  );
  const sorted = builds
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || b.updatedAt || "").localeCompare(a.createdAt || a.updatedAt || ""));
  return c.json(sorted);
});

// GET /web-deploy/:buildId — poll status
webDeploy.get("/:buildId", async (c) => {
  const buildId = c.req.param("buildId");
  const data = await c.env.BUILD_STATUS.get(`build:${buildId}`);
  if (!data) return c.json({ error: "Build not found" }, 404);
  return c.json(JSON.parse(data));
});
