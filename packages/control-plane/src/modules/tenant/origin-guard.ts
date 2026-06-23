import { createMiddleware } from "hono/factory";

/**
 * Origin allowlist for the control plane.
 *
 * The dashboard (app.creek.dev) and this API (api.creek.dev) are the same
 * site, so first-party browser requests always carry one of these origins.
 * localhost (any port) covers local development.
 */
export function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname;
  // localhost dev runs over http; every other allowed origin must be https
  // to match the production model (Secure cookies). This keeps the guard
  // from treating http://app.creek.dev the same as https://app.creek.dev.
  if (host === "localhost") return true;
  if (url.protocol !== "https:") return false;
  if (host === "creek.dev") return true;
  if (host.endsWith(".creek.dev")) return true;
  return false;
}

// GET/HEAD/OPTIONS cannot be CSRF write vectors, and OPTIONS is the CORS
// preflight which must reach the cors() handler.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF guard based on the Origin header.
 *
 * Session cookies are SameSite=Lax, which already keeps them off genuinely
 * cross-site requests. This is the defense-in-depth second layer: even if a
 * cookie scope widens or a "simple request" (text/plain POST) slips past the
 * CORS preflight, a state-changing request carrying a foreign Origin is
 * rejected here.
 *
 * Browsers always attach Origin to state-changing requests and cannot be made
 * to omit it (Origin is a forbidden header name). Non-browser callers — the
 * CLI, CI, GitHub webhooks, internal service-to-service — omit it entirely.
 * So a present-but-disallowed Origin is the CSRF signal we reject; an absent
 * Origin is a trusted non-browser client and passes through.
 */
export const originGuard = createMiddleware(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const origin = c.req.header("origin");
  if (origin !== undefined && !isAllowedOrigin(origin)) {
    return c.json(
      { error: "forbidden", message: "Cross-origin request rejected" },
      403,
    );
  }

  return next();
});
