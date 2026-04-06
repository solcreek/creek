import { _runRequest, generateWsToken } from "creek";
import userModule from "../worker/index";

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
