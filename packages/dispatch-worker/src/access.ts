/**
 * Cloudflare Access enforcement for projects that turned protection on.
 *
 * A protected project sits behind an Access application in the CUSTOMER's
 * Cloudflare account, on the customer's own domain. Access runs on that zone
 * before the request reaches Creek's Cloudflare for SaaS (verified 2026-11-28
 * with a cross-account PoC) and hands us a signed JWT in
 * `Cf-Access-Jwt-Assertion`. Every other address of the project —
 * `{project}-{team}.bycreek.com`, branch and deployment previews, any custom
 * domain the customer did not put behind Access — never passes through their
 * Access, so the header is the only proof a request was let in. It is checked
 * on every hostname, which closes those side doors without enumerating them.
 *
 * Fail closed throughout: a missing, malformed, expired or foreign token is
 * refused, and so is a path this module cannot positively match as bypassed.
 */

/** A project's Access settings, as stored on the project row. */
export interface AccessConfig {
  /** `<team>.cloudflareaccess.com`: issuer of the tokens and host of the keys. */
  teamDomain: string;
  /** The Access application's AUD tag; a token must name it. */
  aud: string;
  /** Path prefixes the customer's Access lets through without a login (decision: bypass). */
  bypassPaths: string[];
}

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD = /^[0-9a-f]{64}$/;
/** Access tokens are ~1 KB. Anything far larger is not one, and isn't worth decoding. */
const MAX_TOKEN_LENGTH = 16 * 1024;
/** Clock skew tolerated on exp/nbf/iat between Cloudflare and this isolate. */
const SKEW_SECONDS = 60;

export function isTeamDomain(value: string): boolean {
  return TEAM_DOMAIN.test(value);
}

export function isAud(value: string): boolean {
  return AUD.test(value);
}

/**
 * Build the config from the project row's three columns. Only a row with all
 * three NULL is unprotected. Anything else that is incomplete or malformed —
 * an empty string, a bypass list with no team, a row written by hand — yields
 * a config no token can satisfy and no path bypasses: a project whose
 * protection is misconfigured must not quietly become public.
 */
export function parseAccessConfig(row: {
  accessTeamDomain?: string | null;
  accessAud?: string | null;
  accessBypassPaths?: string | null;
}): AccessConfig | null {
  const { accessTeamDomain: teamDomain, accessAud: aud, accessBypassPaths } = row;
  if (teamDomain == null && aud == null && accessBypassPaths == null) return null;
  if (!isTeamDomain(teamDomain ?? "") || !isAud(aud ?? "")) {
    return { teamDomain: teamDomain ?? "", aud: aud ?? "", bypassPaths: [] };
  }
  let bypassPaths: string[] = [];
  if (accessBypassPaths) {
    try {
      const parsed: unknown = JSON.parse(accessBypassPaths);
      if (Array.isArray(parsed)) bypassPaths = parsed.filter((p): p is string => isBypassPath(p));
    } catch {
      // Unreadable list: no bypass at all. Fail closed.
    }
  }
  return { teamDomain, aud, bypassPaths } as AccessConfig;
}

// --- Bypass paths ---

/**
 * A bypass entry is an absolute path prefix with no query, fragment, or
 * wildcard except a trailing `/*` (which means the same as the bare prefix).
 */
export function isBypassPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.startsWith("/") || value.length > 256) return false;
  if (/[?#\s\\]/.test(value) || value.includes("//")) return false;
  const body = value.endsWith("/*") ? value.slice(0, -2) : value;
  // `/` and `/*` would bypass the whole site: that is turning protection off.
  if (body === "" || body === "/") return false;
  return !body.includes("*") && !body.includes("/../") && !body.endsWith("/..");
}

/**
 * Whether `pathname` falls under one of the bypass prefixes: the prefix itself,
 * or anything below it at a `/` boundary (`/health` covers `/health` and
 * `/health/live`, never `/healthz`). `pathname` must be a URL's parsed
 * pathname, so dot segments are already resolved. Matching is exact and
 * case-sensitive: where Cloudflare Access would be more lenient, this refuses,
 * which costs a 403 and never a leak.
 */
export function isBypassed(pathname: string, bypassPaths: readonly string[]): boolean {
  for (const entry of bypassPaths) {
    if (!isBypassPath(entry)) continue;
    const prefix = entry.endsWith("/*") ? entry.slice(0, -2) : entry;
    const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (pathname === base || pathname.startsWith(`${base}/`)) return true;
  }
  return false;
}

// --- JWT verification ---

export type VerifyResult =
  | { ok: true; email?: string }
  | {
      ok: false;
      reason:
        | "missing"
        | "malformed"
        | "algorithm"
        | "unknown_key"
        | "signature"
        | "issuer"
        | "audience"
        | "expired"
        | "not_yet_valid"
        | "config";
    };

/** Fetches the team's signing keys. Errors propagate: the caller answers 503. */
export type KeyLookup = (teamDomain: string, kid: string) => Promise<CryptoKey | null>;

function b64urlBytes(segment: string): Uint8Array<ArrayBuffer> {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(b64urlBytes(segment)));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Verify an Access token for `config`: RS256 signature by one of the team's
 * keys, issuer is the team domain, audience names the application, and the
 * token is inside its validity window.
 */
export async function verifyAccessJwt(
  token: string | null,
  config: AccessConfig,
  keys: KeyLookup,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  if (!isTeamDomain(config.teamDomain) || !isAud(config.aud)) {
    return { ok: false, reason: "config" };
  }
  if (!token) return { ok: false, reason: "missing" };
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    return { ok: false, reason: "malformed" };
  }
  const [h, p, s] = parts;
  const header = b64urlJson(h);
  const claims = b64urlJson(p);
  if (!header || !claims) return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256") return { ok: false, reason: "algorithm" };
  if (typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "malformed" };

  const key = await keys(config.teamDomain, header.kid);
  if (!key) return { ok: false, reason: "unknown_key" };

  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = b64urlBytes(s);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) return { ok: false, reason: "signature" };

  if (claims.iss !== `https://${config.teamDomain}`) return { ok: false, reason: "issuer" };
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(config.aud)) return { ok: false, reason: "audience" };
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_SECONDS > nowSeconds) {
    return { ok: false, reason: "not_yet_valid" };
  }
  return { ok: true, email: typeof claims.email === "string" ? claims.email : undefined };
}

// --- Team signing keys ---

interface KeySet {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

/** Keys are reused for this long before a routine refetch. */
const KEYS_TTL_MS = 60 * 60 * 1000;
/**
 * An unknown `kid` may mean Cloudflare rotated keys, so it triggers a refetch —
 * but no more than once per interval per team, or a stream of tokens with
 * made-up kids would turn into a stream of fetches.
 */
const UNKNOWN_KID_REFETCH_MS = 60 * 1000;
/**
 * After a failed fetch, no other fetch for that team for this long: requests
 * meanwhile use the keys already held, or get 503 when there are none, without
 * each waiting on another failing fetch.
 */
const FAILED_FETCH_COOLDOWN_MS = 30 * 1000;
const KEYS_FETCH_TIMEOUT_MS = 5 * 1000;
/** Bounds isolate memory; team domains come from project rows, not requests. */
const KEY_CACHE_MAX = 500;

/**
 * A KeyLookup backed by `https://<team>/cdn-cgi/access/certs`, cached per
 * isolate. `fetcher` is injectable for tests.
 */
export function createKeyLookup(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): KeyLookup {
  const cache = new Map<string, KeySet>();
  const inflight = new Map<string, Promise<KeySet>>();
  /** When a team's last fetch failed; cleared by a success. */
  const failedAt = new Map<string, number>();

  async function load(teamDomain: string): Promise<KeySet> {
    const res = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(KEYS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Access certs for ${teamDomain}: HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: JsonWebKey[] };
    const keys = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      const kid = (jwk as { kid?: unknown }).kid;
      if (typeof kid !== "string" || jwk.kty !== "RSA") continue;
      try {
        keys.set(
          kid,
          await crypto.subtle.importKey(
            "jwk",
            jwk,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          ),
        );
      } catch {
        // Skip a key we can't import; the others may still verify.
      }
    }
    // A key set that verifies nothing is a failed fetch: it must not replace
    // keys that still work, nor turn a retryable 503 into a 403.
    if (keys.size === 0) throw new Error(`Access certs for ${teamDomain}: no usable RSA keys`);
    const set = { keys, fetchedAt: now() };
    if (cache.size >= KEY_CACHE_MAX && !cache.has(teamDomain)) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(teamDomain, set);
    return set;
  }

  /** Single-flight fetch, recording failures for the cooldown. */
  function refresh(teamDomain: string): Promise<KeySet> {
    let pending = inflight.get(teamDomain);
    if (!pending) {
      pending = load(teamDomain)
        .then(
          (set) => {
            failedAt.delete(teamDomain);
            return set;
          },
          (err: unknown) => {
            failedAt.set(teamDomain, now());
            throw err;
          },
        )
        .finally(() => inflight.delete(teamDomain));
      inflight.set(teamDomain, pending);
    }
    return pending;
  }

  function coolingDown(teamDomain: string): boolean {
    const at = failedAt.get(teamDomain);
    return at !== undefined && now() - at < FAILED_FETCH_COOLDOWN_MS;
  }

  return async (teamDomain, kid) => {
    let set = cache.get(teamDomain);
    if (!set || now() - set.fetchedAt >= KEYS_TTL_MS) {
      if (coolingDown(teamDomain)) {
        if (!set) throw new Error(`Access certs for ${teamDomain}: recent fetch failed`);
        // Keys that are merely old still verify the tokens they signed.
      } else {
        try {
          set = await refresh(teamDomain);
        } catch (err) {
          if (!set) throw err;
        }
      }
    }
    const key = set.keys.get(kid);
    if (key) return key;
    if (now() - set.fetchedAt < UNKNOWN_KID_REFETCH_MS) return null;
    // The kid may be a rotated key we can't fetch right now: retryable, not a 403.
    if (coolingDown(teamDomain)) {
      throw new Error(`Access certs for ${teamDomain}: recent fetch failed`);
    }
    set = await refresh(teamDomain);
    return set.keys.get(kid) ?? null;
  };
}

// --- Responses ---

/** 403 for a request the project's Access did not let through. */
export function accessDenied(isCustomDomain: boolean): Response {
  const message = isCustomDomain
    ? "This project is protected by Cloudflare Access, but this domain is not behind its Access application."
    : "This project is protected by Cloudflare Access. Open it on its own domain.";
  return new Response(message, {
    status: 403,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

/** 503 when the team's signing keys can't be fetched: retryable, and never a pass. */
export function accessUnavailable(): Response {
  return new Response("Service Unavailable", {
    status: 503,
    headers: {
      "Retry-After": "5",
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
