/**
 * SPA worker template for WfP Static Assets.
 *
 * This string is embedded into user worker scripts during deploy.
 * __INDEX_HTML__ is replaced with the actual JSON-stringified index.html content.
 *
 * WfP Static Assets limitations handled here:
 * - env.ASSETS.fetch() throws on non-existent paths (not 404)
 * - not_found_handling config is not supported in WfP API
 * - Content-Type is not set by WfP (handled by dispatch worker, not here)
 */
export const SPA_WORKER_SCRIPT = `
const INDEX_HTML = __INDEX_HTML__;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Static asset paths (have a file extension like .js, .css, .png)
    const lastSegment = pathname.split("/").pop() || "";
    if (lastSegment.includes(".")) {
      try {
        const res = await env.ASSETS.fetch(request);
        if (res.ok || res.status === 304) return res;
      } catch {}
    }

    // SPA fallback — return embedded index.html for client-side routing
    return new Response(INDEX_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
};
`;
