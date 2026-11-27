/**
 * CloudflareGrant — one Durable Object per team, the only place a team's
 * Cloudflare OAuth grant lives: its tokens, its status, and the only code
 * that refreshes or revokes it. Nothing about the grant is written to D1, so
 * there is no second copy to fall out of step with this one.
 *
 * Why an object and not rows in D1: Cloudflare rotates refresh tokens, so two
 * refreshes of the same token lose the grant (the second gets invalid_grant).
 * A Durable Object id has exactly one live instance worldwide, so an
 * in-memory single-flight promise serialises refreshes without leases,
 * owners, polling or timing constants that have to agree.
 *
 * One subtlety: an object is NOT strictly single-threaded. While it awaits
 * something other than its own storage (the token request, a revoke, crypto),
 * other requests to it run. So:
 *   - every refresh goes through `this.refreshing`, and the check that starts
 *     one is repeated after the storage read, with nothing awaited between
 *     that check and the assignment;
 *   - a refresh re-checks the grant's generation before storing, so a
 *     connect or disconnect that ran while it waited wins;
 *   - a disconnect goes through `this.closing`: it lets a refresh in flight
 *     finish (so it revokes the token that refresh stored, not the one it
 *     spent), refuses new refreshes, revokes, then deletes — and deletes only
 *     the grant it revoked, never one a concurrent connect just stored.
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
  accounts: CloudflareAccount[];
  connectedByUserId: string;
  createdAt: number;
  updatedAt: number;
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
  /** Whether Cloudflare confirmed the revocation. False: the user should revoke it there too. */
  revoked: boolean;
}

/** What the dashboard may see about a team's grant. Never includes a token. */
export interface ConnectionStatus {
  connected: true;
  accounts: CloudflareAccount[];
  grantedScopes: string[];
  connectedByUserId: string;
  createdAt: number;
  updatedAt: number;
  /** The access token has expired and there is no refresh token to renew it: reconnect. */
  needsReauth: boolean;
}

/** A refresh lost a race with connect/disconnect; the caller starts over. */
const RETRY = Symbol("retry");
type Attempt = TokenResult | typeof RETRY;

const NOT_CONNECTED: TokenResult = {
  ok: false,
  error: "not_connected",
  message: "This team has not connected a Cloudflare account",
};

function isFresh(grant: StoredGrant, now = Date.now()): boolean {
  return grant.accessTokenExpiresAt === null || grant.accessTokenExpiresAt - EXPIRY_SKEW_MS > now;
}

export class CloudflareGrant {
  private refreshing: Promise<Attempt> | null = null;
  private closing: Promise<DisconnectResult> | null = null;
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
      if (request.method === "POST" && path === "/status") {
        return Response.json({ status: await this.status() });
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

  private grant(): Promise<StoredGrant | undefined> {
    return this.state.storage.get<StoredGrant>(GRANT_KEY);
  }

  private async isCurrent(grant: StoredGrant): Promise<boolean> {
    return (await this.grant())?.generation === grant.generation;
  }

  // --- connect ---

  /** Store (or replace) the team's grant. A refresh still in flight on the old one is discarded. */
  async connect(req: ConnectRequest): Promise<void> {
    // A disconnect in progress finishes first; this connect then stands.
    // Without this, a disconnect still waiting on a refresh would read,
    // revoke and delete the grant this connect is about to store.
    if (this.closing) await this.closing;
    const key = this.key();
    const now = Date.now();
    const encryptedAccessToken = await encrypt(req.tokens.accessToken, key);
    const encryptedRefreshToken = req.tokens.refreshToken
      ? await encrypt(req.tokens.refreshToken, key)
      : null;
    const previous = await this.grant();
    const grant: StoredGrant = {
      teamId: req.teamId,
      generation: crypto.randomUUID(),
      encryptedAccessToken,
      encryptedRefreshToken,
      accessTokenExpiresAt: req.tokens.expiresAt,
      scopes: req.tokens.scopes,
      accounts: req.accounts,
      connectedByUserId: req.userId,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await this.state.storage.put(GRANT_KEY, grant);
    this.cache = { generation: grant.generation, accessToken: req.tokens.accessToken };
  }

  // --- status ---

  async status(): Promise<ConnectionStatus | null> {
    const grant = await this.grant();
    if (!grant) return null;
    return {
      connected: true,
      accounts: grant.accounts,
      grantedScopes: grant.scopes,
      connectedByUserId: grant.connectedByUserId,
      createdAt: grant.createdAt,
      updatedAt: grant.updatedAt,
      // Derived from the same record token() reads, so the two cannot disagree.
      needsReauth: !grant.encryptedRefreshToken && !isFresh(grant),
    };
  }

  // --- token ---

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

    const grant = await this.grant();
    // After the read, so it also catches a disconnect that began during it.
    // A grant being disconnected hands out no token, fresh or not, and
    // starts no refresh.
    if (!grant || this.closing) return NOT_CONNECTED;

    if (isFresh(grant)) {
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

    // Another refresh may have started while we read storage. Everything
    // from the `closing` check above to this assignment is synchronous.
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
        // token for the next attempt. status() now derives needsReauth.
        await this.state.storage.put(GRANT_KEY, {
          ...grant,
          encryptedRefreshToken: null,
          updatedAt: Date.now(),
        });
        return { ok: false, error: "reauth_required", message: err.message };
      }
      console.error("[cloudflare-grant] refresh failed:", err);
      return { ok: false, error: "upstream_error", message: String(err) };
    }

    // Encrypt before the generation check so check-then-put has no await
    // between them that another request could slip into.
    const next: StoredGrant = {
      ...grant,
      generation: crypto.randomUUID(),
      encryptedAccessToken: await encrypt(tokens.accessToken, key),
      encryptedRefreshToken: tokens.refreshToken ? await encrypt(tokens.refreshToken, key) : null,
      accessTokenExpiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      updatedAt: Date.now(),
    };
    // Reconnected meanwhile: these tokens belong to a grant that no longer
    // exists here. (A disconnect waits for this refresh, then revokes what
    // it stored.)
    if (!(await this.isCurrent(grant))) return RETRY;
    await this.state.storage.put(GRANT_KEY, next);
    this.cache = { generation: next.generation, accessToken: tokens.accessToken };
    return { ok: true, accessToken: tokens.accessToken };
  }

  // --- disconnect ---

  /** Revoke the grant at Cloudflare (best-effort), then forget it. Concurrent calls share one run. */
  disconnect(): Promise<DisconnectResult> {
    if (!this.closing) {
      this.closing = this.close().finally(() => {
        this.closing = null;
      });
    }
    return this.closing;
  }

  private async close(): Promise<DisconnectResult> {
    // Let a refresh in flight store its result first: otherwise we would
    // revoke the token it spent and then delete the one it was issued,
    // leaving that one live at Cloudflare. No new refresh starts meanwhile
    // (tokenOnce sees `closing`).
    if (this.refreshing) await this.refreshing.catch(() => undefined);

    const grant = await this.grant();
    if (!grant) return { existed: false, revoked: false };

    // Revoke before deleting: if this object dies in between, the grant is
    // still here and a retried disconnect revokes and deletes it.
    let revoked = false;
    const config = oauthConfig(this.env);
    if (config) {
      try {
        const token = grant.encryptedRefreshToken ?? grant.encryptedAccessToken;
        revoked = await revokeToken(config, await decrypt(token, this.key()));
      } catch (err) {
        console.error("[cloudflare-grant] revoke failed:", err);
      }
    }

    // Delete only the grant we revoked. A connect that was already past its
    // own `closing` check may have stored a new one meanwhile; that one stands.
    if (await this.isCurrent(grant)) {
      await this.state.storage.delete(GRANT_KEY);
      this.cache = null;
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
    status: async () => (await call<{ status: ConnectionStatus | null }>("/status")).status,
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
    /** Test hook: the raw stored grant for a team (the live record, mutable). */
    _stored: (name: string) => storages.get(name)?.get(GRANT_KEY) as StoredGrant | undefined,
  };
  return ns as unknown as DurableObjectNamespace & { _stored: typeof ns._stored };
}
