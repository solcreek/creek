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

const stored = () => grants._stored(TEAM);
const issued = (access: string, refresh: string) => () =>
  Response.json({ access_token: access, refresh_token: refresh, expires_in: 3600 });
const rejected = () => Response.json({ error: "invalid_grant" }, { status: 400 });

/**
 * Cloudflare's OAuth server. Token requests take the next queued response;
 * revocations are recorded (and answered 200 unless `revokeFails`).
 */
function cloudflare(...tokenResponses: (() => Response | Promise<Response>)[]) {
  const revoked: string[] = [];
  const tokenCalls: URLSearchParams[] = [];
  let revokeFails = false;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (url.endsWith("/oauth2/revoke")) {
      if (revokeFails) throw new Error("revoke endpoint down");
      revoked.push(body.get("token")!);
      return new Response(null, { status: 200 });
    }
    if (url.endsWith("/oauth2/token")) {
      tokenCalls.push(body);
      const next = tokenResponses.shift();
      if (!next) throw new Error("unexpected token request");
      return next();
    }
    throw new Error(`unexpected request to ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return {
    fn,
    revoked,
    tokenCalls,
    failRevoke: () => {
      revokeFails = true;
    },
  };
}

/** A promise you resolve by hand, to hold a request open mid-flight. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

/** Resolves once the stubbed fetch has been called `n` times. */
async function untilFetched(fn: ReturnType<typeof vi.fn>, n = 1) {
  for (let i = 0; i < 200 && fn.mock.calls.length < n; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(fn.mock.calls.length).toBeGreaterThanOrEqual(n);
}

describe("connect", () => {
  it("stores the tokens encrypted, with the status alongside, and nothing in D1", async () => {
    await connect();
    expect(stored()!.encryptedAccessToken).not.toContain("at1");
    expect(stored()!.encryptedRefreshToken).not.toContain("rt1");
    expect(await client().status()).toMatchObject({
      connected: true,
      connectedByUserId: USER,
      grantedScopes: ["access.write"],
      accounts: [{ id: "acc-1", name: "Acme" }],
      needsReauth: false,
    });
    const rows = t.db.db.prepare("SELECT COUNT(*) AS n FROM cloudflare_connection").get();
    expect(rows).toEqual({ n: 0 });
  });

  it("keeps the first createdAt across a reconnect", async () => {
    await connect();
    const first = stored()!.createdAt;
    stored()!.createdAt = first - 1000;
    await connect({ accessToken: "at2" });
    expect(stored()!.createdAt).toBe(first - 1000);
  });
});

describe("status", () => {
  it("is null for a team without a grant", async () => {
    expect(await client().status()).toBeNull();
  });

  it("needs reauth once a grant without a refresh token has expired, as token() says", async () => {
    await connect({ refreshToken: null, expiresAt: Date.now() + 3600_000 });
    expect((await client().status())!.needsReauth).toBe(false);
    stored()!.accessTokenExpiresAt = 1;
    expect((await client().status())!.needsReauth).toBe(true);
    expect(await client().token()).toMatchObject({ ok: false, error: "reauth_required" });
  });
});

describe("token", () => {
  it("returns a fresh token without calling Cloudflare", async () => {
    const cf = cloudflare();
    await connect();
    expect(await client().token()).toEqual({ ok: true, accessToken: "at1" });
    expect(cf.fn).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token and spends the rotated refresh token next time", async () => {
    await connect({ expiresAt: Date.now() + 10_000 });
    const cf = cloudflare(issued("at2", "rt2"), issued("at3", "rt3"));
    expect(await client().token()).toEqual({ ok: true, accessToken: "at2" });
    stored()!.accessTokenExpiresAt = 1;
    expect(await client().token()).toEqual({ ok: true, accessToken: "at3" });
    expect(cf.tokenCalls.map((b) => b.get("refresh_token"))).toEqual(["rt1", "rt2"]);
  });

  it("refreshes once for many concurrent callers", async () => {
    await connect({ expiresAt: 1 });
    const cf = cloudflare(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return issued("at2", "rt2")();
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => client().token()));
    expect(results).toEqual(Array(5).fill({ ok: true, accessToken: "at2" }));
    expect(cf.tokenCalls).toHaveLength(1);
  });

  it("bounds the token request with an abort signal", async () => {
    await connect({ expiresAt: 1 });
    const cf = cloudflare(issued("at2", "rt2"));
    await client().token();
    expect(cf.fn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(REFRESH_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("drops a refresh token Cloudflare rejects, and status then needs reauth", async () => {
    await connect({ expiresAt: 1 });
    cloudflare(rejected);
    expect(await client().token()).toMatchObject({ ok: false, error: "reauth_required" });
    expect(stored()!.encryptedRefreshToken).toBeNull();
    expect((await client().status())!.needsReauth).toBe(true);
    // Nothing left to spend: no further requests to Cloudflare.
    const cf = cloudflare();
    expect(await client().token()).toMatchObject({ error: "reauth_required" });
    expect(cf.fn).not.toHaveBeenCalled();
  });

  it.each([
    [429, "rate_limited"],
    [401, "invalid_client"],
  ])("keeps the refresh token on a %i %s and retries next time", async (status, error) => {
    await connect({ expiresAt: 1 });
    cloudflare(() => Response.json({ error }, { status }));
    expect(await client().token()).toMatchObject({ ok: false, error: "upstream_error" });
    expect(stored()!.encryptedRefreshToken).not.toBeNull();
    expect((await client().status())!.needsReauth).toBe(false);

    const cf = cloudflare(issued("at2", "rt2"));
    expect(await client().token()).toEqual({ ok: true, accessToken: "at2" });
    expect(cf.tokenCalls[0].get("refresh_token")).toBe("rt1");
  });

  it("keeps the refresh token when Cloudflare is unreachable", async () => {
    await connect({ expiresAt: 1 });
    cloudflare(() => Promise.reject(new Error("network down")));
    expect(await client().token()).toMatchObject({ ok: false, error: "upstream_error" });
    expect(stored()!.encryptedRefreshToken).not.toBeNull();
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

describe("a refresh racing a reconnect", () => {
  it("does not overwrite the reconnected grant with the old grant's tokens", async () => {
    await connect({ expiresAt: 1 });
    cloudflare(async () => {
      await connect({ accessToken: "new-at", refreshToken: "new-rt" });
      return issued("stale-at", "stale-rt")();
    });
    expect(await client().token()).toEqual({ ok: true, accessToken: "new-at" });
    expect(await client().token()).toEqual({ ok: true, accessToken: "new-at" });
  });

  it("does not drop the reconnected grant's refresh token when the old one was rejected", async () => {
    await connect({ expiresAt: 1 });
    cloudflare(async () => {
      await connect({ accessToken: "new-at", refreshToken: "new-rt" });
      return rejected();
    });
    expect(await client().token()).toEqual({ ok: true, accessToken: "new-at" });
    expect(stored()!.encryptedRefreshToken).not.toBeNull();
    expect((await client().status())!.needsReauth).toBe(false);
  });
});

describe("disconnect", () => {
  it("revokes the refresh token, then forgets the grant", async () => {
    await connect();
    const cf = cloudflare();
    expect(await client().disconnect()).toEqual({ existed: true, revoked: true });
    expect(cf.revoked).toEqual(["rt1"]);
    expect(stored()).toBeUndefined();
    expect(await client().status()).toBeNull();
  });

  it("reports existed: false when there was nothing", async () => {
    cloudflare();
    expect(await client().disconnect()).toEqual({ existed: false, revoked: false });
  });

  it("still forgets the grant when revocation fails, and says so", async () => {
    await connect();
    const cf = cloudflare();
    cf.failRevoke();
    expect(await client().disconnect()).toEqual({ existed: true, revoked: false });
    expect(stored()).toBeUndefined();
  });

  it("bounds the revoke request with an abort signal", async () => {
    await connect();
    const cf = cloudflare();
    await client().disconnect();
    expect(cf.fn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("waits for a refresh in flight and revokes the token it was issued, not the one it spent", async () => {
    await connect({ expiresAt: 1 });
    const hold = gate();
    const cf = cloudflare(async () => {
      await hold.opened;
      return issued("at2", "rt2")();
    });

    const token = client().token();
    await untilFetched(cf.fn);
    const disconnect = client().disconnect();
    hold.open();

    expect(await token).toEqual({ ok: true, accessToken: "at2" });
    expect(await disconnect).toEqual({ existed: true, revoked: true });
    expect(cf.revoked).toEqual(["rt2"]);
    expect(stored()).toBeUndefined();
  });

  it("starts no refresh while it is running", async () => {
    await connect({ expiresAt: 1 });
    const hold = gate();
    const cf = cloudflare();
    // Hold the revoke open, then ask for a token meanwhile.
    cf.fn.mockImplementationOnce(async () => {
      await hold.opened;
      return new Response(null, { status: 200 });
    });
    const disconnect = client().disconnect();
    await untilFetched(cf.fn);
    expect(await client().token()).toMatchObject({ ok: false, error: "not_connected" });
    hold.open();
    await disconnect;
    expect(cf.tokenCalls).toHaveLength(0);
  });

  it("hands out no token while it is running, even a fresh one", async () => {
    await connect();
    const hold = gate();
    const cf = cloudflare();
    cf.fn.mockImplementationOnce(async () => {
      await hold.opened;
      return new Response(null, { status: 200 });
    });
    const disconnect = client().disconnect();
    await untilFetched(cf.fn);
    expect(await client().token()).toMatchObject({ ok: false, error: "not_connected" });
    hold.open();
    await disconnect;
  });

  it("lets a connect issued while it waits on a refresh stand, instead of revoking it", async () => {
    await connect({ expiresAt: 1 });
    const hold = gate();
    const cf = cloudflare(async () => {
      await hold.opened;
      return issued("at2", "rt2")();
    });
    const token = client().token();
    await untilFetched(cf.fn);
    const disconnect = client().disconnect(); // waits for the refresh
    const reconnect = connect({ accessToken: "new-at", refreshToken: "new-rt" });
    hold.open();
    await Promise.all([token, disconnect, reconnect]);

    expect(cf.revoked).toEqual(["rt2"]); // the refreshed old grant, not the new one
    expect(await client().token()).toEqual({ ok: true, accessToken: "new-at" });
  });

  it("lets a connect that arrives during it stand, after it", async () => {
    await connect();
    const hold = gate();
    const cf = cloudflare();
    cf.fn.mockImplementationOnce(async () => {
      await hold.opened;
      return new Response(null, { status: 200 });
    });
    const disconnect = client().disconnect();
    await untilFetched(cf.fn);
    const reconnect = connect({ accessToken: "new-at", refreshToken: "new-rt" });
    hold.open();
    await disconnect;
    await reconnect;
    expect(await client().token()).toEqual({ ok: true, accessToken: "new-at" });
  });

  it("does not delete a grant a connect stored while it was revoking", async () => {
    await connect();
    const hold = gate();
    const cf = cloudflare();
    cf.fn.mockImplementationOnce(async () => {
      // A connect already past its own wait stores a new grant mid-revoke.
      // (Called on the object directly: its wait for `closing` is what the
      // previous test covers.)
      stored()!.generation = "replaced-by-a-concurrent-connect";
      await hold.opened;
      return new Response(null, { status: 200 });
    });
    const disconnect = client().disconnect();
    await untilFetched(cf.fn);
    hold.open();
    expect(await disconnect).toEqual({ existed: true, revoked: true });
    expect(stored()?.generation).toBe("replaced-by-a-concurrent-connect");
  });

  it("revokes while the grant is still stored, so a disconnect that dies midway can be retried", async () => {
    await connect();
    const cf = cloudflare();
    let storedDuringRevoke: unknown;
    cf.fn.mockImplementationOnce(async () => {
      storedDuringRevoke = stored();
      return new Response(null, { status: 200 });
    });
    await client().disconnect();
    expect(storedDuringRevoke).toBeDefined();
    expect(stored()).toBeUndefined();
  });
});

describe("getCloudflareAccessToken", () => {
  it("returns the token, or throws the typed errors callers branch on", async () => {
    await expect(getCloudflareAccessToken(env, TEAM)).rejects.toBeInstanceOf(
      CloudflareNotConnectedError,
    );
    await connect();
    expect(await getCloudflareAccessToken(env, TEAM)).toBe("at1");

    stored()!.accessTokenExpiresAt = 1;
    cloudflare(rejected);
    await expect(getCloudflareAccessToken(env, TEAM)).rejects.toBeInstanceOf(
      CloudflareReauthRequiredError,
    );
  });

  it("refuses to run without the CLOUDFLARE_GRANTS binding", async () => {
    env.CLOUDFLARE_GRANTS = undefined;
    await expect(getCloudflareAccessToken(env, TEAM)).rejects.toThrow(/CLOUDFLARE_GRANTS/);
  });
});
