/**
 * Creek Remote Builder — Worker that manages a Build Container DO.
 *
 * GET  /         → health check (wakes container)
 * POST /build    → build only, return bundle JSON
 * POST /deploy   → build + deploy to Creek API, return live URL
 */

import { Container } from "@cloudflare/containers";
import { deployToCreek } from "./creek-api.js";

export class BuildContainer extends Container {
  defaultPort = 8080;
  override sleepAfter = "5m" as const;
}

type Env = {
  BUILD_CONTAINER: DurableObjectNamespace<BuildContainer>;
  INTERNAL_SECRET?: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const container = getContainer(env);

    // Health check — also wakes the container
    if (request.method === "GET") {
      try {
        const res = await container.fetch("http://container:8080/");
        const data = await res.json();
        return Response.json({ worker: "ok", container: data }, { headers: corsHeaders() });
      } catch {
        return Response.json({
          worker: "ok",
          container: "starting",
          hint: "Container cold start takes ~2 min after deploy. Retry shortly.",
        }, { headers: corsHeaders() });
      }
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Internal auth check (required when INTERNAL_SECRET is set)
    if (env.INTERNAL_SECRET) {
      const secret = request.headers.get("x-internal-secret");
      if (secret !== env.INTERNAL_SECRET) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    const body = await request.json<{
      repoUrl: string;
      branch?: string;
      path?: string;
      templateData?: Record<string, unknown>;
      creekApiUrl?: string;
      creekToken?: string;
      projectSlug?: string;
    }>();

    if (!body.repoUrl) {
      return Response.json({ error: "repoUrl is required" }, { status: 400, headers: corsHeaders() });
    }

    // Forward build request to container
    let buildResult: any;
    try {
      const buildRes = await container.fetch("http://container:8080/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: body.repoUrl,
          branch: body.branch,
          path: body.path,
          templateData: body.templateData,
        }),
      });
      buildResult = await buildRes.json();
    } catch (err) {
      return Response.json({
        error: "build_failed",
        message: err instanceof Error ? err.message : String(err),
        hint: "Container may be starting. Retry in 30s.",
      }, { status: 502, headers: corsHeaders() });
    }

    if (!buildResult.success) {
      return Response.json(buildResult, { status: 422, headers: corsHeaders() });
    }

    // /build → return build result only
    if (url.pathname === "/build") {
      return Response.json(buildResult, { headers: corsHeaders() });
    }

    // /deploy → build + deploy to Creek API
    if (!body.creekToken) {
      return Response.json({
        ...buildResult,
        deploy: { error: "creekToken required for deploy" },
      }, { headers: corsHeaders() });
    }

    const apiUrl = body.creekApiUrl || "https://api.creek.dev";
    const slug = body.projectSlug ||
      buildResult.config?.workerEntry?.split("/").pop()?.replace(/\.\w+$/, "") ||
      "remote-build";

    try {
      const deployResult = await deployToCreek(
        apiUrl,
        body.creekToken,
        slug,
        buildResult.config?.framework ?? undefined,
        buildResult.bundle,
      );

      return Response.json({
        ...buildResult,
        deploy: deployResult,
      }, { headers: corsHeaders() });
    } catch (err) {
      return Response.json({
        ...buildResult,
        deploy: {
          success: false,
          error: "deploy_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      }, { headers: corsHeaders() });
    }
  },
};

// --- Helpers ---

function getContainer(env: Env) {
  const id = env.BUILD_CONTAINER.idFromName("creek-builder");
  return env.BUILD_CONTAINER.get(id);
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
