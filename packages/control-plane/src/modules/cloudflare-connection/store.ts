/**
 * Persistence for "Connect Cloudflare": pending authorization requests and
 * each team's grant, plus the one way the rest of control-plane gets a usable
 * Cloudflare token for a team — getCloudflareAccessToken().
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../types.js";
import { decrypt, encrypt } from "../env/crypto.js";
import {
  DEFAULT_SCOPES,
  OAuthGrantError,
  buildAuthorizeUrl,
  pkceChallenge,
  randomToken,
  refreshTokens,
  type CloudflareAccount,
  type OAuthClientConfig,
  type TokenSet,
} from "./oauth.js";

/** How long a user has to finish the Cloudflare consent screen. */
export const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before the access token actually expires. */
export const EXPIRY_SKEW_MS = 60 * 1000;
/** How long one caller may hold the refresh lease. */
export const REFRESH_LEASE_MS = 30 * 1000;
/**
 * The token request is aborted after this, well inside the lease, so a slow
 * Cloudflare cannot keep a refresh running after another caller may have
 * taken the lease over and spent the same (rotating) refresh token.
 */
export const REFRESH_TIMEOUT_MS = 10 * 1000;

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

// --- Connections ---

interface ConnectionRow {
  teamId: string;
  connectedByUserId: string | null;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  accessTokenExpiresAt: number | null;
  grantedScopes: string;
  accounts: string;
  generation: string;
  refreshLeaseUntil: number | null;
  refreshLeaseOwner: string | null;
  createdAt: number;
  updatedAt: number;
}

function requireKey(env: Env): string {
  if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is not configured");
  return env.ENCRYPTION_KEY;
}

/**
 * Store (or replace) a team's grant under a new generation, voiding any
 * refresh still in flight against the previous grant.
 */
export async function saveConnection(
  env: Env,
  teamId: string,
  userId: string,
  tokens: TokenSet,
  accounts: CloudflareAccount[],
): Promise<void> {
  const key = requireKey(env);
  const now = Date.now();
  const access = await encrypt(tokens.accessToken, key);
  const refresh = tokens.refreshToken ? await encrypt(tokens.refreshToken, key) : null;

  await env.DB.prepare(
    `INSERT INTO cloudflare_connection
       (teamId, connectedByUserId, encryptedAccessToken, encryptedRefreshToken,
        accessTokenExpiresAt, grantedScopes, accounts, generation, refreshLeaseUntil,
        createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT (teamId) DO UPDATE SET
       connectedByUserId = excluded.connectedByUserId,
       encryptedAccessToken = excluded.encryptedAccessToken,
       encryptedRefreshToken = excluded.encryptedRefreshToken,
       accessTokenExpiresAt = excluded.accessTokenExpiresAt,
       grantedScopes = excluded.grantedScopes,
       accounts = excluded.accounts,
       generation = excluded.generation,
       refreshLeaseUntil = NULL,
       refreshLeaseOwner = NULL,
       updatedAt = excluded.updatedAt`,
  )
    .bind(
      teamId,
      userId,
      access,
      refresh,
      tokens.expiresAt,
      tokens.scopes.join(" "),
      JSON.stringify(accounts),
      crypto.randomUUID(),
      now,
      now,
    )
    .run();
}

async function readRow(db: D1Database, teamId: string): Promise<ConnectionRow | null> {
  return db
    .prepare("SELECT * FROM cloudflare_connection WHERE teamId = ?")
    .bind(teamId)
    .first<ConnectionRow>();
}

function isFresh(row: ConnectionRow, now: number): boolean {
  return row.accessTokenExpiresAt === null || row.accessTokenExpiresAt - EXPIRY_SKEW_MS > now;
}

export interface ConnectionStatus {
  connected: true;
  accounts: CloudflareAccount[];
  grantedScopes: string[];
  connectedByUserId: string | null;
  createdAt: number;
  updatedAt: number;
  /** The token is expired and cannot be refreshed: reconnect. */
  needsReauth: boolean;
}

/** What the dashboard may see about a team's grant. Never includes a token. */
export async function getConnectionStatus(
  db: D1Database,
  teamId: string,
): Promise<ConnectionStatus | null> {
  const row = await readRow(db, teamId);
  if (!row) return null;
  let accounts: CloudflareAccount[] = [];
  try {
    accounts = JSON.parse(row.accounts);
  } catch {
    // A malformed column shows as no accounts rather than breaking the page.
  }
  return {
    connected: true,
    accounts,
    grantedScopes: row.grantedScopes.split(" ").filter(Boolean),
    connectedByUserId: row.connectedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    needsReauth: !isFresh(row, Date.now()) && !row.encryptedRefreshToken,
  };
}

/**
 * Remove a team's grant. Returns null when there was none; otherwise its
 * decrypted tokens for revocation at Cloudflare (tokens null if unreadable).
 */
export async function deleteConnection(
  env: Env,
  teamId: string,
): Promise<{ tokens: { accessToken: string; refreshToken: string | null } | null } | null> {
  const row = await env.DB.prepare(
    `DELETE FROM cloudflare_connection WHERE teamId = ?
     RETURNING encryptedAccessToken, encryptedRefreshToken`,
  )
    .bind(teamId)
    .first<Pick<ConnectionRow, "encryptedAccessToken" | "encryptedRefreshToken">>();
  if (!row) return null;
  const key = env.ENCRYPTION_KEY;
  if (!key) return { tokens: null };
  try {
    return {
      tokens: {
        accessToken: await decrypt(row.encryptedAccessToken, key),
        refreshToken: row.encryptedRefreshToken
          ? await decrypt(row.encryptedRefreshToken, key)
          : null,
      },
    };
  } catch {
    return { tokens: null };
  }
}

// --- Tokens for callers ---

export interface TokenOptions {
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** How many times to wait for another caller's refresh before giving up. */
  maxWaits?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A Cloudflare access token for the team, refreshed when it is about to
 * expire. Throws CloudflareNotConnectedError / CloudflareReauthRequiredError.
 *
 * Cloudflare rotates refresh tokens, so only one caller may refresh at a
 * time: it takes a short lease on the row (a conditional UPDATE, atomic in
 * D1); everyone else waits and re-reads the row the winner wrote.
 */
export async function getCloudflareAccessToken(
  env: Env,
  config: OAuthClientConfig,
  teamId: string,
  opts: TokenOptions = {},
): Promise<string> {
  const key = requireKey(env);
  const sleep = opts.sleep ?? defaultSleep;
  const maxWaits = opts.maxWaits ?? 20;

  for (let attempt = 0; attempt <= maxWaits; attempt++) {
    const row = await readRow(env.DB, teamId);
    if (!row) throw new CloudflareNotConnectedError();

    const now = Date.now();
    if (isFresh(row, now)) return decrypt(row.encryptedAccessToken, key);
    if (!row.encryptedRefreshToken) {
      throw new CloudflareReauthRequiredError("access token expired and no refresh token");
    }

    // Every write below is fenced by both the grant generation and this
    // lease owner: once our lease has run out and someone else holds it, we
    // neither store our tokens nor release their lease.
    const owner = crypto.randomUUID();
    const lease = await env.DB.prepare(
      `UPDATE cloudflare_connection SET refreshLeaseUntil = ?, refreshLeaseOwner = ?
       WHERE teamId = ? AND generation = ?
         AND (refreshLeaseUntil IS NULL OR refreshLeaseUntil < ?)`,
    )
      .bind(now + REFRESH_LEASE_MS, owner, teamId, row.generation, now)
      .run();

    if (lease.meta.changes !== 1) {
      // Someone else is refreshing (or just replaced the grant). Wait, re-read.
      await sleep(500);
      continue;
    }

    let tokens: TokenSet;
    try {
      tokens = await refreshTokens(
        config,
        await decrypt(row.encryptedRefreshToken, key),
        row.grantedScopes.split(" ").filter(Boolean),
        AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      );
    } catch (err) {
      if (err instanceof OAuthGrantError && err.code === "invalid_grant") {
        // RFC 6749 §5.2: the refresh token is expired, revoked or spent. Drop
        // it so status shows needsReauth, unless the grant was replaced
        // meanwhile. Any other error (a 429, invalid_client from our own
        // misconfiguration) leaves the token for the next attempt.
        const dropped = await env.DB.prepare(
          `UPDATE cloudflare_connection
           SET encryptedRefreshToken = NULL, refreshLeaseUntil = NULL, refreshLeaseOwner = NULL
           WHERE teamId = ? AND generation = ? AND refreshLeaseOwner = ?`,
        )
          .bind(teamId, row.generation, owner)
          .run();
        // The team reconnected, or our lease was taken over: not ours to drop.
        if (dropped.meta.changes !== 1) continue;
        throw new CloudflareReauthRequiredError(err.code);
      }
      await env.DB.prepare(
        `UPDATE cloudflare_connection SET refreshLeaseUntil = NULL, refreshLeaseOwner = NULL
         WHERE teamId = ? AND generation = ? AND refreshLeaseOwner = ?`,
      )
        .bind(teamId, row.generation, owner)
        .run();
      throw err;
    }

    const write = await env.DB.prepare(
      `UPDATE cloudflare_connection SET
         encryptedAccessToken = ?, encryptedRefreshToken = ?, accessTokenExpiresAt = ?,
         grantedScopes = ?, generation = ?, refreshLeaseUntil = NULL, refreshLeaseOwner = NULL,
         updatedAt = ?
       WHERE teamId = ? AND generation = ? AND refreshLeaseOwner = ?`,
    )
      .bind(
        await encrypt(tokens.accessToken, key),
        tokens.refreshToken ? await encrypt(tokens.refreshToken, key) : null,
        tokens.expiresAt,
        tokens.scopes.join(" "),
        crypto.randomUUID(),
        Date.now(),
        teamId,
        row.generation,
        owner,
      )
      .run();
    if (write.meta.changes !== 1) {
      // The team reconnected, or our lease was taken over: ours is stale.
      continue;
    }
    return tokens.accessToken;
  }

  throw new Error("Timed out waiting for another request to refresh the Cloudflare token");
}
