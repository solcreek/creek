/**
 * SPA worker template for WfP Static Assets.
 *
 * Handles:
 * - Serve static assets from ASSETS binding
 * - SPA fallback: non-asset paths serve /index.html content
 *
 * Note: WfP Static Assets may redirect /index.html → / (307).
 * We follow redirects manually to get the actual content.
 */
export const SPA_WORKER_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Static asset paths (have a file extension)
    const lastSegment = pathname.split("/").pop() || "";
    if (lastSegment.includes(".")) {
      return env.ASSETS.fetch(request);
    }

    // SPA route — serve index.html content
    // Fetch /index.html, follow any redirects
    const indexReq = new Request(url.origin + "/index.html", {
      method: "GET",
      redirect: "follow",
    });
    const res = await env.ASSETS.fetch(indexReq);

    // If we got a redirect, follow it manually
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("Location");
      if (location) {
        return env.ASSETS.fetch(new Request(location, { method: "GET" }));
      }
    }

    return res;
  }
};
`;
