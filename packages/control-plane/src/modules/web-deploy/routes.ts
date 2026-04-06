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

interface DeployRequest {
  type: "template" | "repo";
  template?: string;
  data?: Record<string, string>;
  repo?: string;
  branch?: string;
  path?: string;
}

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
  if (currentCount >= 3) {
    return c.json({
      error: "rate_limited",
      message: "You've used all 3 free deploys this hour.",
      action: "Sign up for unlimited deploys — free forever.",
      signupUrl: "https://creek.dev/docs/getting-started",
      retryAfter: 3600,
    }, 429);
  }
  await c.env.BUILD_STATUS.put(rateLimitKey, String(currentCount + 1), { expirationTtl: 3600 });

  // Generate build ID
  const buildId = crypto.randomUUID().slice(0, 12);

  // Store initial status
  await c.env.BUILD_STATUS.put(
    `build:${buildId}`,
    JSON.stringify({
      buildId,
      status: "building",
      type: body.type,
      createdAt: new Date().toISOString(),
    }),
    { expirationTtl: 3600 },
  );

  // Background: build + deploy
  c.executionCtx.waitUntil(buildAndDeploy(buildId, body, c.env));

  return c.json({ buildId, statusUrl: `/web-deploy/${buildId}` }, 202);
});

// GET /web-deploy/:buildId — poll status
webDeploy.get("/:buildId", async (c) => {
  const buildId = c.req.param("buildId");
  const data = await c.env.BUILD_STATUS.get(`build:${buildId}`);
  if (!data) return c.json({ error: "Build not found" }, 404);
  return c.json(JSON.parse(data));
});

// --- Background task ---

async function buildAndDeploy(buildId: string, body: DeployRequest, env: Env) {
  try {
    let buildReq: Record<string, unknown>;
    if (body.type === "template") {
      buildReq = {
        repoUrl: "https://github.com/solcreek/templates",
        path: body.template,
        templateData: body.data,
      };
    } else {
      const repoUrl = body.repo!.startsWith("http") ? body.repo! : `https://github.com/${body.repo}`;
      buildReq = { repoUrl, branch: body.branch, path: body.path };
    }

    // Call remote builder via service binding
    const buildRes = await env.REMOTE_BUILDER.fetch("http://remote-builder/build", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": env.INTERNAL_SECRET,
      },
      body: JSON.stringify(buildReq),
    });

    const buildResult = (await buildRes.json()) as any;

    if (!buildResult.success) {
      await env.BUILD_STATUS.put(
        `build:${buildId}`,
        JSON.stringify({
          buildId,
          status: "failed",
          error: buildResult.message || buildResult.error || "Build failed",
          failedStep: "build",
        }),
        { expirationTtl: 3600 },
      );
      return;
    }

    // Update: deploying
    await env.BUILD_STATUS.put(
      `build:${buildId}`,
      JSON.stringify({ buildId, status: "deploying" }),
      { expirationTtl: 3600 },
    );

    // Forward bundle to sandbox API
    const sandboxRes = await fetch(`${env.SANDBOX_API_URL}/api/sandbox/deploy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": env.INTERNAL_SECRET,
      },
      body: JSON.stringify({
        assets: buildResult.bundle.assets,
        serverFiles: buildResult.bundle.serverFiles,
        manifest: buildResult.bundle.manifest,
        framework: buildResult.config.framework,
        source: "web",
      }),
    });

    if (!sandboxRes.ok) {
      const err = await sandboxRes.text();
      await env.BUILD_STATUS.put(
        `build:${buildId}`,
        JSON.stringify({
          buildId,
          status: "failed",
          error: `Deploy failed: ${err.slice(0, 200)}`,
          failedStep: "deploy",
        }),
        { expirationTtl: 3600 },
      );
      return;
    }

    const sandbox = (await sandboxRes.json()) as any;

    // Poll sandbox until active
    let sandboxStatus = sandbox;
    for (let i = 0; i < 60; i++) {
      if (sandboxStatus.status === "active" || sandboxStatus.status === "failed") break;
      await new Promise((r) => setTimeout(r, 1000));
      const statusRes = await fetch(sandbox.statusUrl);
      sandboxStatus = await statusRes.json();
    }

    if (sandboxStatus.status === "active") {
      await env.BUILD_STATUS.put(
        `build:${buildId}`,
        JSON.stringify({
          buildId,
          status: "active",
          sandboxId: sandbox.sandboxId,
          previewUrl: sandbox.previewUrl,
          expiresAt: sandbox.expiresAt,
        }),
        { expirationTtl: 3600 },
      );
    } else {
      await env.BUILD_STATUS.put(
        `build:${buildId}`,
        JSON.stringify({
          buildId,
          status: "failed",
          error: sandboxStatus.errorMessage || "Deploy timed out",
          failedStep: "deploy",
        }),
        { expirationTtl: 3600 },
      );
    }
  } catch (err) {
    await env.BUILD_STATUS.put(
      `build:${buildId}`,
      JSON.stringify({
        buildId,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        failedStep: "build",
      }),
      { expirationTtl: 3600 },
    );
  }
}

function hashIp(ip: string): string {
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    hash = ((hash << 5) - hash) + ip.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
