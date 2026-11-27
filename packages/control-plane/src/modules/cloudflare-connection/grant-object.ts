/**
 * CloudflareGrant — one Durable Object per team, the only place a team's
 * Cloudflare OAuth tokens live and the only code that refreshes them.
 *
 * Why an object and not rows in D1: Cloudflare rotates refresh tokens, so two
 * refreshes of the same token lose the grant (the second gets invalid_grant).
 * A Durable Object id has exactly one live instance worldwide, so an
 * in-memory single-flight promise serialises refreshes without leases,
 * owners, polling or timing constants that have to agree.
 *
 * One subtlety: an object is NOT strictly single-threaded. While it awaits an
 * outbound fetch (the token request), other requests to it run. That is why
 * every refresh goes through `this.refreshing`, and why a refresh re-checks
 * the grant's generation before storing: a connect or disconnect may have
 * run while it waited.
 *
 * The object also keeps the team's `cloudflare_grant` row in D1 (status
 * metadata, never a token) so the dashboard can list it without waking the
 * object. It is that row's only writer.
 *
 * Deliberately a plain class (no `cloudflare:workers` import) so the same
 * code runs in workerd, in the local dev server and under vitest via
 * createInMemoryGrantNamespace().
 */

import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { Env } from "../../types.js";
import { decrypt, encrypt } from "../env/crypto.js";
import {
  OAuthGrantError,
  refreshTokens,
  revokeToken,
  type CloudflareAccount,
  type TokenSet,
} from "./oauth.js";
import {
  CloudflareNotConnectedError,
  CloudflareReauthRequiredError,
  oauthConfig,
} from "./store.js";

/** Refresh this long before the access token actually expires. */
export const EXPIRY_SKEW_MS = 60 * 1000;
/**
 * The token request is aborted after this so a hung request cannot block the
 * team's refreshes forever. Aborting only stops our side: if Cloudflare
 * rotated the token anyway, that token never reached us and the next attempt
 * ends in invalid_grant → reconnect, as it would without a retry.
 */
export const REFRESH_TIMEOUT_MS = 20 * 1000;

interface StoredGrant {
  teamId: string;
  /** Fresh random value on every write: a refresh begun on an older grant can tell. */
  generation: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  accessTokenExpiresAt: number | null;
  scopes: string[];
}

const GRANT_KEY = "grant";

/** The subset of DurableObjectStorage this object uses. */
export interface GrantStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export type TokenResult =
  | { ok: true; accessToken: string }
  | {
      ok: false;
      error: "not_connected" | "reauth_required" | "not_configured" | "upstream_error";
      message: string;
    };

export interface ConnectRequest {
  teamId: string;
  userId: string;
  tokens: TokenSet;
  accounts: CloudflareAccount[];
}

export interface DisconnectResult {
  existed: boolean;
  revoked: boolean;
}

/** A refresh lost a race with connect/disconnect; the caller starts over. */
const RETRY = Symbol("retry");
type Attempt = TokenResult | typeof RETRY;

export class CloudflareGrant {
  private refreshing: Promise<Attempt> | null = null;
  /** Decrypted access token for the current generation, to skip PBKDF2 on every call. */
  private cache: { generation: string; accessToken: string } | null = null;

  constructor(
    private readonly state: { storage: GrantStorage },
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "POST" && path === "/connect") {
        await this.connect((await request.json()) as ConnectRequest);
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === "/token") {
        return Response.json(await this.token());
      }
      if (request.method === "POST" && path === "/disconnect") {
        return Response.json(await this.disconnect());
      }
      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error(`[cloudflare-grant] ${path} failed:`, err);
      return Response.json({ ok: false, error: "internal", message: String(err) }, { status: 500 });
    }
  }

  private key(): string {
    if (!this.env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is not configured");
    return this.env.ENCRYPTION_KEY;
  }

  /** Store (or replace) the team's grant. A refresh still in flight on the old one is discarded. */
  async connect(req: ConnectRequest): Promise<void> {
    const key = this.key();
    const grant: StoredGrant = {
      teamId: req.teamId,
      generation: crypto.randomUUID(),
      encryptedAccessToken: await encrypt(req.tokens.accessToken, key),
      encryptedRefreshToken: req.tokens.refreshToken
        ? await encrypt(req.tokens.refreshToken, key)
        : null,
      accessTokenExpiresAt: req.tokens.expiresAt,
      scopes: req.tokens.scopes,
    };
    await this.state.storage.put(GRANT_KEY, grant);
    this.cache = { generation: grant.generation, accessToken: req.tokens.accessToken };

    const now = Date.now();
    await this.env.DB.prepare(
      `INSERT INTO cloudflare_grant
         (teamId, connectedByUserId, grantedScopes, accounts, needsReauth, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (teamId) DO UPDATE SET
         connectedByUserId = excluded.connectedByUserId,
         grantedScopes = excluded.grantedScopes,
         accounts = excluded.accounts,
         needsReauth = 0,
         updatedAt = excluded.updatedAt`,
    )
      .bind(req.teamId, req.userId, grant.scopes.join(" "), JSON.stringify(req.accounts), now, now)
      .run();
  }

  /** A usable access token, refreshing it (once, for all concurrent callers) when it is about to expire. */
  async token(): Promise<TokenResult> {
    // A retry means a connect/disconnect replaced the grant mid-refresh;
    // the next pass sees the new state. Bounded in case they keep racing.
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await this.tokenOnce();
      if (result !== RETRY) return result;
    }
    return {
      ok: false,
      error: "upstream_error",
      message: "The grant kept changing during refresh",
    };
  }

  private async tokenOnce(): Promise<Attempt> {
    if (this.refreshing) return this.refreshing;

    const grant = await this.state.storage.get<StoredGrant>(GRANT_KEY);
    if (!grant) {
      return {
        ok: false,
        error: "not_connected",
        message: "This team has not connected a Cloudflare account",
      };
    }

    const fresh =
      grant.accessTokenExpiresAt === null ||
      grant.accessTokenExpiresAt - EXPIRY_SKEW_MS > Date.now();
    if (fresh) {
      if (this.cache?.generation === grant.generation) {
        return { ok: true, accessToken: this.cache.accessToken };
      }
      const accessToken = await decrypt(grant.encryptedAccessToken, this.key());
      this.cache = { generation: grant.generation, accessToken };
      return { ok: true, accessToken };
    }

    if (!grant.encryptedRefreshToken) {
      return {
        ok: false,
        error: "reauth_required",
        message: "The Cloudflare connection must be re-authorized",
      };
    }

    // Another request may have started a refresh while we read storage.
    // Everything from this check to the assignment is synchronous.
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh(grant).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(grant: StoredGrant): Promise<Attempt> {
    const config = oauthConfig(this.env);
    if (!config) {
      return {
        ok: false,
        error: "not_configured",
        message: "No Cloudflare OAuth client is configured",
      };
    }
    const key = this.key();

    let tokens: TokenSet;
    try {
      tokens = await refreshTokens(
        config,
        await decrypt(grant.encryptedRefreshToken!, key),
        grant.scopes,
        AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      );
    } catch (err) {
      if (!(await this.isCurrent(grant))) return RETRY;
      if (err instanceof OAuthGrantError && err.code === "invalid_grant") {
        // RFC 6749 §5.2: expired, revoked or spent. Anything else (a 429,
        // invalid_client from our own misconfiguration, a timeout) keeps the
        // token for the next attempt.
        await this.state.storage.put(GRANT_KEY, { ...grant, encryptedRefreshToken: null });
        await this.writeMeta(grant.teamId, { needsReauth: true });
        return { ok: false, error: "reauth_required", message: err.message };
      }
      console.error("[cloudflare-grant] refresh failed:", err);
      return { ok: false, error: "upstream_error", message: String(err) };
    }

    // Encrypt before the generation check so check-then-put has no await
    // between them that another request could slip into.
    const next: StoredGrant = {
      teamId: grant.teamId,
      generation: crypto.randomUUID(),
      encryptedAccessToken: await encrypt(tokens.accessToken, key),
      encryptedRefreshToken: tokens.refreshToken ? await encrypt(tokens.refreshToken, key) : null,
      accessTokenExpiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
    };
    // Reconnected or disconnected meanwhile: these tokens belong to a grant
    // that no longer exists here.
    if (!(await this.isCurrent(grant))) return RETRY;
    await this.state.storage.put(GRANT_KEY, next);
    this.cache = { generation: next.generation, accessToken: tokens.accessToken };
    await this.writeMeta(grant.teamId, { needsReauth: false, scopes: tokens.scopes });
    return { ok: true, accessToken: tokens.accessToken };
  }

  private async isCurrent(grant: StoredGrant): Promise<boolean> {
    const current = await this.state.storage.get<StoredGrant>(GRANT_KEY);
    return current?.generation === grant.generation;
  }

  /** Status metadata for the dashboard. Best-effort: the object's storage is the source of truth. */
  private async writeMeta(
    teamId: string,
    meta: { needsReauth: boolean; scopes?: string[] },
  ): Promise<void> {
    try {
      await this.env.DB.prepare(
        `UPDATE cloudflare_grant SET needsReauth = ?, grantedScopes = COALESCE(?, grantedScopes),
           updatedAt = ? WHERE teamId = ?`,
      )
        .bind(meta.needsReauth ? 1 : 0, meta.scopes?.join(" ") ?? null, Date.now(), teamId)
        .run();
    } catch (err) {
      console.error("[cloudflare-grant] status update failed:", err);
    }
  }

  /** Forget the grant and revoke it at Cloudflare (best-effort). */
  async disconnect(): Promise<DisconnectResult> {
    const grant = await this.state.storage.get<StoredGrant>(GRANT_KEY);
    await this.state.storage.delete(GRANT_KEY);
    this.cache = null;
    if (!grant) return { existed: false, revoked: false };

    await this.env.DB.prepare("DELETE FROM cloudflare_grant WHERE teamId = ?")
      .bind(grant.teamId)
      .run();

    // Revoking the refresh token ends the whole grant at Cloudflare.
    const config = oauthConfig(this.env);
    let revoked = false;
    if (config && this.env.ENCRYPTION_KEY) {
      try {
        const token = grant.encryptedRefreshToken ?? grant.encryptedAccessToken;
        revoked = await revokeToken(config, await decrypt(token, this.env.ENCRYPTION_KEY));
      } catch (err) {
        console.error("[cloudflare-grant] revoke failed:", err);
      }
    }
    return { existed: true, revoked };
  }
}

// --- Calling the object ---

/** The team's grant object. Throws if this instance has no CLOUDFLARE_GRANTS binding. */
export function grantClient(env: Env, teamId: string) {
  const ns = env.CLOUDFLARE_GRANTS;
  if (!ns) throw new Error("CLOUDFLARE_GRANTS binding is not configured");
  const stub = ns.get(ns.idFromName(teamId));
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await stub.fetch(`https://cloudflare-grant${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`CloudflareGrant ${path} failed (${res.status})`);
    return (await res.json()) as T;
  };
  return {
    connect: (req: ConnectRequest) => call<{ ok: true }>("/connect", req),
    token: () => call<TokenResult>("/token"),
    disconnect: () => call<DisconnectResult>("/disconnect"),
  };
}

/**
 * The one way the rest of control-plane gets a Cloudflare token for a team.
 * Throws CloudflareNotConnectedError / CloudflareReauthRequiredError, or a
 * plain Error for configuration and upstream failures.
 */
export async function getCloudflareAccessToken(env: Env, teamId: string): Promise<string> {
  const result = await grantClient(env, teamId).token();
  if (result.ok) return result.accessToken;
  if (result.error === "not_connected") throw new CloudflareNotConnectedError();
  if (result.error === "reauth_required") throw new CloudflareReauthRequiredError(result.message);
  throw new Error(`Cloudflare token unavailable (${result.error}): ${result.message}`);
}

/**
 * A stand-in for the CLOUDFLARE_GRANTS namespace, for the local dev server
 * and tests: one CloudflareGrant per name, with in-memory storage. Like the
 * real namespace, every get() for a name reaches the same instance.
 */
export function createInMemoryGrantNamespace(env: Env) {
  const instances = new Map<string, CloudflareGrant>();
  const storages = new Map<string, Map<string, unknown>>();

  function storageFor(name: string): GrantStorage {
    let map = storages.get(name);
    if (!map) storages.set(name, (map = new Map()));
    const m = map;
    return {
      async get<T>(key: string) {
        const v = m.get(key);
        return v === undefined ? undefined : (structuredClone(v) as T);
      },
      async put<T>(key: string, value: T) {
        m.set(key, structuredClone(value));
      },
      async delete(key: string) {
        return m.delete(key);
      },
    };
  }

  const ns = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let obj = instances.get(id);
      if (!obj) instances.set(id, (obj = new CloudflareGrant({ storage: storageFor(id) }, env)));
      const instance = obj;
      return {
        fetch: (input: string, init?: RequestInit) => instance.fetch(new Request(input, init)),
      };
    },
    /** Test hook: the raw stored grant for a team. */
    _stored: (name: string) => storages.get(name)?.get(GRANT_KEY) as StoredGrant | undefined,
  };
  return ns as unknown as DurableObjectNamespace & { _stored: typeof ns._stored };
}
