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
  options?: { hasClientAssets?: boolean; spaFallbackHtml?: string },
): string {
  let importPath = relative(wrapperDir, entryPoint).replace(/\\/g, "/");
  // Remove .ts/.tsx extension — esbuild resolves it
  importPath = importPath.replace(/\.tsx?$/, "");
  if (!importPath.startsWith(".")) importPath = "./" + importPath;

  const hasAssets = options?.hasClientAssets ?? false;

  // Worker + static-assets hybrid. Routing model: Cloudflare Static Assets
  // serves matching files at the edge BEFORE the worker runs, so the only
  // requests that reach here are API calls and asset MISSES. env.ASSETS is
  // NOT bound to the dispatched worker under Workers for Platforms, so the
  // SPA deep-link fallback can't fetch index.html at runtime — we embed the
  // built index.html and return it for unmatched GET navigations (the same
  // mechanism the pure-SPA deploy path uses). When there's no index.html to
  // embed, spaShell is null and behaviour is unchanged (handler 404 stands).
  if (hasAssets) {
    const spaShell =
      options?.spaFallbackHtml != null
        ? JSON.stringify(options.spaFallbackHtml)
        : "null";
    return `import { _runRequest, generateWsToken } from "creek";
import userModule from "${importPath}";

const handler = userModule.default ?? userModule;
const SPA_SHELL = ${spaShell};

function isApiPath(pathname) {
  return pathname.startsWith("/api/") || pathname === "/__creek/config";
}

function hasExtension(pathname) {
  const last = pathname.split("/").pop() || "";
  return last.includes(".");
}

// Only browser document navigations should get the SPA shell. An XHR/fetch
// to a missing route (Sec-Fetch-Dest "empty", Accept application/json) must
// keep its real 404 — this mode has a backend, so a miss isn't always a
// client-side route.
function isNavigation(request) {
  if (request.headers.get("Sec-Fetch-Dest") === "document") return true;
  return (request.headers.get("Accept") || "").includes("text/html");
}

async function callHandler(request, env, ctx) {
  if (typeof handler.fetch === "function") return handler.fetch(request, env, ctx);
  if (typeof handler === "function") return handler(request, env, ctx);
  return null;
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

      const res = await callHandler(request, env, ctx);
      if (res && res.status !== 404) return res;

      // A 404 under /api/* is a real API 404 — never serve the SPA shell.
      if (isApiPath(url.pathname)) {
        return res ?? new Response("Not Found", { status: 404 });
      }

      // SPA deep-link fallback: an unmatched browser navigation (GET) to an
      // extensionless path (e.g. /tickets/123 on hard refresh) gets the
      // client app shell so the router can take over. XHR/fetch misses keep
      // their real 404.
      if (
        SPA_SHELL !== null &&
        request.method === "GET" &&
        !hasExtension(url.pathname) &&
        isNavigation(request)
      ) {
        return new Response(SPA_SHELL, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return res ?? new Response("Not Found", { status: 404 });
    });
  },
  ${generateScheduledHandler()}
  ${generateQueueHandler()}
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
  ${generateScheduledHandler()}
  ${generateQueueHandler()}
};
`;
}

function generateScheduledHandler(): string {
  return `async scheduled(event, env, ctx) {
    if (typeof handler.scheduled === "function") {
      return _runRequest(env, ctx, () => handler.scheduled(event, env, ctx));
    }
  },`;
}

function generateQueueHandler(): string {
  return `async queue(batch, env, ctx) {
    if (typeof handler.queue === "function") {
      return _runRequest(env, ctx, () => handler.queue(batch, env, ctx));
    }
  },`;
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
  options?: { hasClientAssets?: boolean; spaFallbackHtml?: string },
): Promise<string> {
  const wrapperDir = join(cwd, ".creek");
  mkdirSync(wrapperDir, { recursive: true });

  const wrapper = generateWorkerWrapper(entryPoint, wrapperDir, options);
  const wrapperPath = join(wrapperDir, "__worker_entry.js");
  writeFileSync(wrapperPath, wrapper);

  return bundleSSRServer(wrapperPath);
}
