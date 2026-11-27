/**
 * D1 persistence for "Connect Cloudflare": only the pending authorization
 * requests (between the redirect to Cloudflare and the callback), plus the
 * OAuth client config. Everything about a team's grant — tokens and status —
 * lives in its CloudflareGrant Durable Object (grant-object.ts).
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../types.js";
import {
  DEFAULT_SCOPES,
  buildAuthorizeUrl,
  pkceChallenge,
  randomToken,
  type OAuthClientConfig,
} from "./oauth.js";

/** How long a user has to finish the Cloudflare consent screen. */
export const STATE_TTL_MS = 10 * 60 * 1000;

export const CALLBACK_PATH = "/oauth/cloudflare/callback";

export class CloudflareNotConnectedError extends Error {
  constructor() {
    super("This team has not connected a Cloudflare account");
    this.name = "CloudflareNotConnectedError";
  }
}

/** The grant is gone (revoked, expired, refresh token spent): a team admin must reconnect. */
export class CloudflareReauthRequiredError extends Error {
  constructor(reason: string) {
    super(`The Cloudflare connection must be re-authorized: ${reason}`);
    this.name = "CloudflareReauthRequiredError";
  }
}

/** The OAuth client config, or null when this instance has no client registered. */
export function oauthConfig(env: Env): OAuthClientConfig | null {
  if (!env.CLOUDFLARE_OAUTH_CLIENT_ID || !env.CLOUDFLARE_OAUTH_CLIENT_SECRET) return null;
  const scopes = env.CLOUDFLARE_OAUTH_SCOPES?.split(/\s+/).filter(Boolean);
  return {
    clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID,
    clientSecret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
    redirectUri: new URL(CALLBACK_PATH, env.BETTER_AUTH_URL).toString(),
    scopes: scopes?.length ? scopes : [...DEFAULT_SCOPES],
  };
}

export function dashboardUrl(env: Env): string {
  return env.DASHBOARD_URL ?? "https://app.creek.dev";
}

/**
 * A same-origin dashboard path to return to, or null. Only "/x..." paths:
 * "//host", "/\host" and absolute URLs would make the callback an open redirect.
 */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  if (/[\u0000-\u001f]/.test(value)) return null;
  return value;
}

// --- Authorization requests ---

export async function createAuthorizationRequest(
  env: Env,
  config: OAuthClientConfig,
  req: { teamId: string; userId: string; returnTo: string | null },
): Promise<string> {
  const state = randomToken();
  const verifier = randomToken();
  const now = Date.now();

  await env.DB.batch([
    // Opportunistic sweep; the table only ever holds requests in flight.
    env.DB.prepare("DELETE FROM cloudflare_oauth_state WHERE expiresAt < ?").bind(now),
    env.DB.prepare(
      `INSERT INTO cloudflare_oauth_state (state, teamId, userId, codeVerifier, returnTo, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(state, req.teamId, req.userId, verifier, req.returnTo, now + STATE_TTL_MS),
  ]);

  return buildAuthorizeUrl(config, state, await pkceChallenge(verifier));
}

export interface PendingAuthorization {
  teamId: string;
  userId: string;
  codeVerifier: string;
  returnTo: string | null;
  expiresAt: number;
}

/** Take a pending request out of the table. Single use: a replayed state finds nothing. */
export async function consumeState(
  db: D1Database,
  state: string,
): Promise<PendingAuthorization | null> {
  return db
    .prepare(
      `DELETE FROM cloudflare_oauth_state WHERE state = ?
       RETURNING teamId, userId, codeVerifier, returnTo, expiresAt`,
    )
    .bind(state)
    .first<PendingAuthorization>();
}
