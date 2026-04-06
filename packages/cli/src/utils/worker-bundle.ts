import { writeFileSync, mkdirSync } from "fs";
import { join, relative } from "path";
import { bundleSSRServer } from "./ssr-bundle.js";

/**
 * Generate the wrapper entry source that auto-injects _setEnv(env).
 *
 * The wrapper:
 * 1. Imports _setEnv from creek runtime
 * 2. Imports the user's app (Hono, custom Worker, etc.)
 * 3. Calls _setEnv(env) before each request
 * 4. Delegates to the user's fetch handler
 * 5. If the handler returns 404, falls back to static assets (WfP Static Assets API)
 */
export function generateWorkerWrapper(
  entryPoint: string,
  wrapperDir: string,
  options?: { hasClientAssets?: boolean },
): string {
  let importPath = relative(wrapperDir, entryPoint).replace(/\\/g, "/");
  // Remove .ts/.tsx extension — esbuild resolves it
  importPath = importPath.replace(/\.tsx?$/, "");
  if (!importPath.startsWith(".")) importPath = "./" + importPath;

  const hasAssets = options?.hasClientAssets ?? false;

  // When client assets exist (Worker + SPA hybrid):
  // - Try static assets first for non-API paths
  // - Fall back to the worker handler for API routes
  // - SPA fallback: serve index.html for extensionless paths
  if (hasAssets) {
    return `import { _runRequest, generateWsToken } from "creek";
import userModule from "${importPath}";

const handler = userModule.default ?? userModule;

function isApiPath(pathname) {
  return pathname.startsWith("/api/") || pathname === "/__creek/config";
}

function hasExtension(pathname) {
  const last = pathname.split("/").pop() || "";
  return last.includes(".");
}

export default {
  async fetch(request, env, ctx) {
    return _runRequest(env, ctx, async () => {
      const url = new URL(request.url);

      // /__creek/config — auto-discovery for CreekRoom WebSocket
      if (url.pathname === "/__creek/config" && request.method === "GET") {
        const wsToken = await generateWsToken();
        return new Response(JSON.stringify({
          realtimeUrl: env.CREEK_REALTIME_URL || null,
          projectSlug: env.CREEK_PROJECT_SLUG || null,
          wsToken,
        }), { headers: { "Content-Type": "application/json" } });
      }

      // API routes → always go to the worker handler
      if (isApiPath(url.pathname)) {
        if (typeof handler.fetch === "function") return handler.fetch(request, env, ctx);
        if (typeof handler === "function") return handler(request, env, ctx);
      }

      // Static assets → try WfP Static Assets API
      if (env.ASSETS) {
        try {
          const assetResponse = await env.ASSETS.fetch(request);
          if (assetResponse.status !== 404) return assetResponse;
        } catch {}

        // SPA fallback: extensionless paths → index.html
        if (!hasExtension(url.pathname)) {
          try {
            const indexReq = new Request(new URL("/index.html", request.url), request);
            const indexResponse = await env.ASSETS.fetch(indexReq);
            if (indexResponse.status !== 404) {
              return new Response(indexResponse.body, {
                status: 200,
                headers: indexResponse.headers,
              });
            }
          } catch {}
        }
      }

      // Fallback: pass to worker handler
      if (typeof handler.fetch === "function") return handler.fetch(request, env, ctx);
      if (typeof handler === "function") return handler(request, env, ctx);
      return new Response("Not Found", { status: 404 });
    });
  },
};
`;
  }

  // Pure Worker (no client assets)
  return `import { _runRequest, generateWsToken } from "creek";
import userModule from "${importPath}";

const handler = userModule.default ?? userModule;

export default {
  async fetch(request, env, ctx) {
    return _runRequest(env, ctx, async () => {
      // /__creek/config — auto-discovery for CreekRoom WebSocket
      const url = new URL(request.url);
      if (url.pathname === "/__creek/config" && request.method === "GET") {
        const wsToken = await generateWsToken();
        return new Response(JSON.stringify({
          realtimeUrl: env.CREEK_REALTIME_URL || null,
          projectSlug: env.CREEK_PROJECT_SLUG || null,
          wsToken,
        }), { headers: { "Content-Type": "application/json" } });
      }

      if (typeof handler.fetch === "function") return handler.fetch(request, env, ctx);
      if (typeof handler === "function") return handler(request, env, ctx);
      throw new Error("[creek] Worker must export default a fetch handler, Hono app, or { fetch() } object.");
    });
  },
};
`;
}

/**
 * Bundle a Worker entry point with Creek runtime auto-injection.
 *
 * 1. Generates a wrapper entry that calls _setEnv(env)
 * 2. Bundles wrapper + user code + creek runtime with esbuild
 * 3. Returns the bundled JavaScript string
 */
export async function bundleWorker(
  entryPoint: string,
  cwd: string,
  options?: { hasClientAssets?: boolean },
): Promise<string> {
  const wrapperDir = join(cwd, ".creek");
  mkdirSync(wrapperDir, { recursive: true });

  const wrapper = generateWorkerWrapper(entryPoint, wrapperDir, options);
  const wrapperPath = join(wrapperDir, "__worker_entry.js");
  writeFileSync(wrapperPath, wrapper);

  return bundleSSRServer(wrapperPath);
}
