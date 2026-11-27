import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import type { Env } from "../../types.js";
import {
  REFRESH_TIMEOUT_MS,
  createInMemoryGrantNamespace,
  getCloudflareAccessToken,
  grantClient,
} from "./grant-object.js";
import type { TokenSet } from "./oauth.js";
import { CloudflareNotConnectedError, CloudflareReauthRequiredError } from "./store.js";

const TEAM = "team-1";
const USER = "user-1";

let t: LocalTestEnv;
let env: Env;
let grants: ReturnType<typeof createInMemoryGrantNamespace>;

beforeEach(() => {
  t = createLocalTestEnv();
  env = {
    ...t.env,
    BETTER_AUTH_URL: "https://api.creek.dev",
    ENCRYPTION_KEY: "test-encryption-key",
    CLOUDFLARE_OAUTH_CLIENT_ID: "creek-client",
    CLOUDFLARE_OAUTH_CLIENT_SECRET: "s3cret",
  };
  grants = createInMemoryGrantNamespace(env);
  env.CLOUDFLARE_GRANTS = grants;
  const now = Date.now();
  t.db.db.exec(
    `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
     VALUES ('${USER}', 'u', 'u@example.com', 1, ${now}, ${now});
     INSERT INTO organization (id, name, slug, createdAt) VALUES ('${TEAM}', 'T', 't', ${now});`,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  t.cleanup();
});

const client = () => grantClient(env, TEAM);

async function connect(tokens: Partial<TokenSet> = {}) {
  await client().connect({
    teamId: TEAM,
    userId: USER,
    tokens: {
      accessToken: "at1",
      refreshToken: "rt1",
      expiresAt: Date.now() + 3600_000,
      scopes: ["access.write"],
      ...tokens,
    },
    accounts: [{ id: "acc-1", name: "Acme" }],
  });
}

/** Cloudflare's token endpoint: each call takes the next response. */
function tokenEndpoint(...responses: (() => Response | Promise<Response>)[]) {
  const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected token request");
    return next();
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const issued = (access: string, refresh: string) => () =>
  Response.json({ access_token: access, refresh_token: refresh, expires_in: 3600 });

const sentRefreshToken = (fn: ReturnType<typeof tokenEndpoint>, call: number) =>
  new URLSearchParams(String(fn.mock.calls[call][1]?.body)).get("refresh_token");

function grantRow() {
  return t.db.db.prepare("SELECT * FROM cloudflare_grant WHERE teamId = ?").get(TEAM) as
    | Record<string, any>
    | undefined;
}

describe("connect", () => {
  it("stores the tokens encrypted in the object and only status in D1", async () => {
    await connect();
    const stored = grants._stored(TEAM)!;
    expect(stored.encryptedAccessToken).not.toContain("at1");
    expect(stored.encryptedRefreshToken).not.toContain("rt1");
    expect(grantRow()).toMatchObject({
      connectedByUserId: USER,
      grantedScopes: "access.write",
      needsReauth: 0,
    });
    expect(JSON.stringify(grantRow())).not.toMatch(/at1|rt1/);
  });
});

describe("token", () => {
  it("returns a fresh token without calling Cloudflare", async () => {
    const fn = tokenEndpoint();
    await connect();
    expect(await client().token()).toEqual({ ok: true, accessToken: "at1" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token and spends the rotated refresh token next time", async () => {
    await connect({ expiresAt: Date.now() + 10_000 });
    const fn = tokenEndpoint(issued("at2", "rt2"));
    expect(await client().token()).toEqual({ ok: true, accessToken: "at2" });
    expect(sentRefreshToken(fn, 0)).toBe("rt1");

    // Expire it again: the next refresh must send rt2.
    const stored = grants._stored(TEAM)!;
    stored.accessTokenExpiresAt = 1;
    const fn2 = tokenEndpoint(issued("at3", "rt3"));
    expect(await client().token()).toEqual({ ok: true, accessToken: "at3" });
    expect(sentRefreshToken(fn2, 0)).toBe("rt2");
  });

  it("refreshes once for many concurrent callers", async () => {
    await connect({ expiresAt: 1 });
    const fn = tokenEndpoint(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return issued("at2", "rt2")();
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => client().token()));
    expect(results).toEqual(Array(5).fill({ ok: true, accessToken: "at2" }));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("aborts a token request that hangs", async () => {
    await connect({ expiresAt: 1 });
    const fn = tokenEndpoint(issued("at2", "rt2"));
    await client().token();
    const signal = fn.mock.calls[0][1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(REFRESH_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("drops a refresh token Cloudflare rejects and marks the grant needsReauth", async () => {
    await connect({ expiresAt: 1 });
    tokenEndpoint(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    expect(await client().token()).toMatchObject({ ok: false, error: "reauth_required" });
    expect(grants._stored(TEAM)!.encryptedRefreshToken).toBeNull();
    expect(grantRow()!.needsReauth).toBe(1);
    // No refresh token left: no further requests to Cloudflare.
    const fn = tokenEndpoint();
    expect(await client().token()).toMatchObject({ error: "reauth_required" });
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    [429, "rate_limited"],
    [401, "invalid_client"],
  ])("keeps the refresh token on a %i %s and retries next time", async (status, error) => {
    await connect({ expiresAt: 1 });
    tokenEndpoint(() => Response.json({ error }, { status }));
    expect(await client().token()).toMatchObject({ ok: false, error: "upstream_error" });
    expect(grants._stored(TEAM)!.encryptedRefreshToken).not.toBeNull();
    expect(grantRow()!.needsReauth).toBe(0);

    const fn = tokenEndpoint(issued("at2", "rt2"));
    expect(await client().token()).toEqual({ ok: true, accessToken: "at2" });
    expect(sentRefreshToken(fn, 0)).toBe("rt1");
  });

  it("keeps the refresh token when Cloudflare is unreachable", async () => {
    await connect({ expiresAt: 1 });
    tokenEndpoint(() => Promise.reject(new Error("network down")));
    expect(await client().token()).toMatchObject({ ok: false, error: "upstream_error" });
    expect(grants._stored(TEAM)!.encryptedRefreshToken).not.toBeNull();
  });

  it("says not_configured when the OAuth client is missing and a refresh is due", async () => {
    await connect({ expiresAt: 1 });
    env.CLOUDFLARE_OAUTH_CLIENT_SECRET = undefined;
    expect(await client().token()).toMatchObject({ ok: false, error: "not_configured" });
  });

  it("says not_connected for a team without a grant", async () => {
    expect(await client().token()).toMatchObject({ ok: false, error: "not_connected" });
  });
});

describe("a refresh racing a reconnect or disconnect", () => {
  /** The token request, before answering, lets `during` run (as another request would). */
  function tokenEndpointThatYields(during: () => Promise<unknown>, response: () => Response) {
    return tokenEndpoint(async () => {
      await during();
      return response();
    });
  }

  it("does not overwrite a reconnected grant with the old grant's tokens", async () => {
    await connect({ expiresAt: 1 });
    tokenEndpointThatYields(
      () => connect({ accessToken: "new-at", refreshToken: "new-rt" }),
      issued("stale-at", "stale-rt"),
    );
    expect(await client().token()).toEqual({ ok: true, accessToken: "new-at" });
    expect(await client().token()).toEqual({ ok: true, accessToken: "new-at" });
  });

  it("does not drop a reconnected grant's refresh token when the old one was rejected", async () => {
    await connect({ expiresAt: 1 });
    tokenEndpointThatYields(
      () => connect({ accessToken: "new-at", refreshToken: "new-rt" }),
      () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    expect(await client().token()).toEqual({ ok: true, accessToken: "new-at" });
    expect(grants._stored(TEAM)!.encryptedRefreshToken).not.toBeNull();
    expect(grantRow()!.needsReauth).toBe(0);
  });

  it("does not resurrect a grant that was disconnected mid-refresh", async () => {
    await connect({ expiresAt: 1 });
    // The disconnect revokes at Cloudflare, so the endpoint answers twice.
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/oauth2/revoke")) return new Response(null, { status: 200 });
        if (first) {
          first = false;
          await client().disconnect();
        }
        return issued("stale-at", "stale-rt")();
      }),
    );
    expect(await client().token()).toMatchObject({ ok: false, error: "not_connected" });
    expect(grants._stored(TEAM)).toBeUndefined();
    expect(grantRow()).toBeUndefined();
  });
});

describe("disconnect", () => {
  it("revokes the refresh token and forgets the grant", async () => {
    await connect();
    const fn = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fn);
    expect(await client().disconnect()).toEqual({ existed: true, revoked: true });
    expect(String((fn.mock.calls[0] as unknown[])[0])).toBe(
      "https://dash.cloudflare.com/oauth2/revoke",
    );
    expect(grants._stored(TEAM)).toBeUndefined();
    expect(grantRow()).toBeUndefined();
  });

  it("reports existed: false when there was nothing", async () => {
    expect(await client().disconnect()).toEqual({ existed: false, revoked: false });
  });
});

describe("getCloudflareAccessToken", () => {
  it("returns the token, or throws the typed errors callers branch on", async () => {
    await expect(getCloudflareAccessToken(env, TEAM)).rejects.toBeInstanceOf(
      CloudflareNotConnectedError,
    );
    await connect();
    expect(await getCloudflareAccessToken(env, TEAM)).toBe("at1");

    grants._stored(TEAM)!.accessTokenExpiresAt = 1;
    tokenEndpoint(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(getCloudflareAccessToken(env, TEAM)).rejects.toBeInstanceOf(
      CloudflareReauthRequiredError,
    );
  });

  it("refuses to run without the CLOUDFLARE_GRANTS binding", async () => {
    env.CLOUDFLARE_GRANTS = undefined;
    await expect(getCloudflareAccessToken(env, TEAM)).rejects.toThrow(/CLOUDFLARE_GRANTS/);
  });
});
