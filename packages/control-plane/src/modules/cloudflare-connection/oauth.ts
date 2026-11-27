/**
 * Cloudflare OAuth client — the protocol half of "Connect Cloudflare".
 *
 * Creek registers one OAuth client with Cloudflare (Authorization Code grant,
 * confidential client, PKCE on top). A team owner authorizes it against their
 * own Cloudflare account(s); Creek then manages Access applications and DNS
 * there on their behalf. Every Access seat lives in the customer's account,
 * not Creek's.
 *
 * Endpoints are the ones wrangler uses (dash.cloudflare.com/oauth2/*). Scope
 * ids are API token permission ids, listed by GET /client/v4/oauth/scopes
 * (verified 2026-11-26: access.write, access-acct.read, zone.read, dns.write
 * all exist). Cloudflare lets the user decline optional scopes, so callers
 * must read the granted `scope` from the token response, never assume it.
 */

export const CLOUDFLARE_AUTH_ORIGIN = "https://dash.cloudflare.com";
export const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";

/**
 * What Creek asks for by default. `offline_access` is the OIDC scope that
 * yields a refresh token (wrangler requests it the same way); the rest are
 * the least that lets Creek put Access in front of a customer hostname:
 *   access.write      — Access applications and their policies
 *   access-acct.read  — the Zero Trust org and its identity providers, so the
 *                       dashboard can offer the customer's own login methods
 *   zone.read         — list the customer's zones to pick a hostname from
 *   dns.write         — create the proxied CNAME that points at Creek
 *   account-settings.read — name the accounts the user granted
 * Override with CLOUDFLARE_OAUTH_SCOPES (space-separated) to match the scopes
 * registered on the OAuth client.
 */
export const DEFAULT_SCOPES = [
  "offline_access",
  "account-settings.read",
  "zone.read",
  "dns.write",
  "access.write",
  "access-acct.read",
] as const;

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms; null when Cloudflare gave no expires_in. */
  expiresAt: number | null;
  /** What the user actually granted — may be fewer than requested. */
  scopes: string[];
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

/** The token endpoint refused the grant (bad/expired/reused code or refresh token). */
export class OAuthGrantError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    description?: string,
  ) {
    super(`Cloudflare OAuth error ${code} (${status})${description ? `: ${description}` : ""}`);
    this.name = "OAuthGrantError";
  }
}

// --- PKCE + state ---

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A high-entropy URL-safe random string (32 bytes → 43 chars). */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** RFC 7636 S256 challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// --- Authorization request ---

export function buildAuthorizeUrl(
  config: OAuthClientConfig,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL("/oauth2/auth", CLOUDFLARE_AUTH_ORIGIN);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// --- Token endpoint ---

function basicAuth(config: OAuthClientConfig): string {
  return `Basic ${btoa(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`)}`;
}

async function tokenRequest(
  config: OAuthClientConfig,
  params: Record<string, string>,
  fallbackScopes: string[],
  signal?: AbortSignal,
): Promise<TokenSet> {
  const res = await fetch(new URL("/oauth2/token", CLOUDFLARE_AUTH_ORIGIN), {
    method: "POST",
    signal,
    headers: {
      authorization: basicAuth(config),
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });

  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body || typeof body.access_token !== "string") {
    const code = typeof body?.error === "string" ? body.error : "invalid_response";
    const description =
      typeof body?.error_description === "string" ? body.error_description : undefined;
    throw new OAuthGrantError(code, res.status, description);
  }

  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresAt: expiresIn === null ? null : Date.now() + expiresIn * 1000,
    scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : fallbackScopes,
  };
}

/** Exchange an authorization code (with its PKCE verifier) for tokens. */
export function exchangeCode(
  config: OAuthClientConfig,
  code: string,
  codeVerifier: string,
): Promise<TokenSet> {
  return tokenRequest(
    config,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
    },
    config.scopes,
  );
}

/**
 * Trade a refresh token for a new token set. Cloudflare's server rotates
 * refresh tokens: the old one is spent, so the caller must persist the new
 * one before anyone else refreshes (see store.ts for the lease).
 */
export async function refreshTokens(
  config: OAuthClientConfig,
  refreshToken: string,
  previousScopes: string[],
  signal?: AbortSignal,
): Promise<TokenSet> {
  const tokens = await tokenRequest(
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    previousScopes,
    signal,
  );
  // A server that doesn't rotate returns no new refresh token: keep the old one.
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

/** Best-effort RFC 7009 revocation. Never throws: disconnect must still succeed locally. */
export async function revokeToken(config: OAuthClientConfig, token: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/oauth2/revoke", CLOUDFLARE_AUTH_ORIGIN), {
      method: "POST",
      headers: {
        authorization: basicAuth(config),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Cloudflare API ---

/** The accounts this token can act on — the ones the user picked on the consent screen. */
export async function listAccounts(accessToken: string): Promise<CloudflareAccount[]> {
  const res = await fetch(new URL("/client/v4/accounts?per_page=50", CLOUDFLARE_API_ORIGIN), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: { id?: unknown; name?: unknown }[];
  } | null;
  if (!res.ok || !body?.success || !Array.isArray(body.result)) {
    throw new Error(`Cloudflare GET /accounts failed (${res.status})`);
  }
  return body.result
    .filter((a): a is { id: string; name: string } => typeof a.id === "string")
    .map((a) => ({ id: a.id, name: typeof a.name === "string" ? a.name : a.id }));
}
