import type { Context } from "hono";
import type { Env } from "../../types.js";

export const TURNSTILE_HEADER = "cf-turnstile-response";
export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Auth endpoints protected by Cloudflare Turnstile and their expected widget actions.
 * Must match the `action` prop passed to the Turnstile widget in apps/dashboard.
 */
export const AUTH_TURNSTILE_ACTIONS: Readonly<Record<string, string>> = {
  "/api/auth/sign-in/email": "login",
  "/api/auth/sign-up/email": "signup",
};

export type TurnstileVerifyResult =
  | { ok: true; skipped?: boolean }
  | {
      ok: false;
      reason:
        | "misconfigured"
        | "missing_token"
        | "verification_failed"
        | "action_mismatch"
        | "hostname_mismatch"
        | "siteverify_error";
    };

export function parseAllowedHostnames(raw?: string): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((hostname) => hostname.trim())
      .filter(Boolean),
  );
}

export function extractClientIp(headers: Headers): string | undefined {
  const cfIp = headers.get("cf-connecting-ip")?.trim();
  if (cfIp && cfIp !== "unknown") return cfIp;

  const forwardedFor = headers.get("x-forwarded-for");
  if (!forwardedFor) return undefined;
  const firstIp = forwardedFor.split(",")[0]?.trim();
  return firstIp && firstIp !== "unknown" ? firstIp : undefined;
}

export function normalizePathname(pathname: string): string {
  let normalized = pathname.replace(/\/{2,}/g, "/");
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export interface VerifyTurnstileOptions {
  secret?: string;
  hostnames?: string;
  token: unknown;
  expectedAction: string;
  remoteIp?: string;
  /**
   * When true (e.g., production HTTPS deployments), missing Turnstile configuration
   * fails closed instead of bypassing verification.
   */
  failClosedWhenUnconfigured?: boolean;
}

/**
 * Canonical Cloudflare Turnstile Siteverify check.
 * Fails closed on network/HTTP/JSON errors, action mismatches, or hostname mismatches.
 */
export async function verifyTurnstileToken(
  opts: VerifyTurnstileOptions,
): Promise<TurnstileVerifyResult> {
  const secret = opts.secret?.trim() ?? "";
  const allowedHostnames = parseAllowedHostnames(opts.hostnames);
  const enforced =
    secret.length > 0 || allowedHostnames.size > 0 || Boolean(opts.failClosedWhenUnconfigured);

  if (!enforced) {
    return { ok: true, skipped: true };
  }

  if (!secret || allowedHostnames.size === 0) {
    console.error("[turnstile] Verification enforced but secret or hostnames allowlist is missing");
    return { ok: false, reason: "misconfigured" };
  }

  if (typeof opts.token !== "string" || opts.token.length === 0 || opts.token.length > 2048) {
    return { ok: false, reason: "missing_token" };
  }

  let result: { success?: unknown; action?: unknown; hostname?: unknown };
  try {
    const body = new URLSearchParams({
      secret,
      response: opts.token,
      ...(opts.remoteIp ? { remoteip: opts.remoteIp } : {}),
    });
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body,
    });
    if (!res.ok) {
      throw new Error(`siteverify ${res.status}`);
    }
    result = (await res.json()) as { success?: unknown; action?: unknown; hostname?: unknown };
  } catch (err) {
    console.error(
      "[turnstile] Siteverify request failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: "siteverify_error" };
  }

  if (result?.success !== true) {
    return { ok: false, reason: "verification_failed" };
  }
  if (result.action !== opts.expectedAction) {
    return { ok: false, reason: "action_mismatch" };
  }
  if (typeof result.hostname !== "string" || !allowedHostnames.has(result.hostname)) {
    return { ok: false, reason: "hostname_mismatch" };
  }

  return { ok: true };
}

/**
 * Verify Turnstile tokens on protected Better Auth email sign-in / sign-up endpoints.
 * Returns a 403 Response when verification fails, or null to let Better Auth proceed.
 */
export async function verifyAuthTurnstile<E extends { Bindings: Env }>(
  c: Context<E>,
): Promise<Response | null> {
  if (c.req.method !== "POST") return null;

  const pathname = normalizePathname(new URL(c.req.url).pathname);
  const expectedAction = AUTH_TURNSTILE_ACTIONS[pathname];
  if (!expectedAction) return null;

  const result = await verifyTurnstileToken({
    secret: c.env.TURNSTILE_DASHBOARD_SECRET,
    hostnames: c.env.TURNSTILE_DASHBOARD_HOSTNAMES,
    token: c.req.header(TURNSTILE_HEADER),
    expectedAction,
    remoteIp: extractClientIp(c.req.raw.headers),
    failClosedWhenUnconfigured: Boolean(c.env.BETTER_AUTH_URL?.startsWith("https://")),
  });

  if (!result.ok) {
    return c.json(
      { error: "turnstile_failed", message: "Verification failed. Please try again." },
      403,
    );
  }

  return null;
}
