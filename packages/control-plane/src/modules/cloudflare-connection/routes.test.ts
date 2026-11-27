import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import type { Env } from "../../types.js";

// The callback reads the Better Auth session; tests decide who is signed in.
const session = vi.hoisted(() => ({ current: null as null | { user: Record<string, unknown> } }));
vi.mock("../tenant/auth.js", () => ({
  createAuth: () => ({ api: { getSession: async () => session.current } }),
}));

const { cloudflareConnection, cloudflareOAuthCallback } = await import("./routes.js");
const store = await import("./store.js");
const { pkceChallenge } = await import("./oauth.js");

const TEAM = "team-1";
const OWNER = "user-owner";
const MEMBER = "user-member";
const OTHER = "user-other";
const auditCtx = { ip: "1.2.3.4", ipHash: "h", country: null, userAgent: null, cfRay: null };

let t: LocalTestEnv;
let env: Env;

function seed() {
  const now = Date.now();
  const db = t.db.db;
  for (const id of [OWNER, MEMBER, OTHER]) {
    db.exec(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('${id}', '${id}', '${id}@example.com', 1, ${now}, ${now})`,
    );
  }
  db.exec(
    `INSERT INTO organization (id, name, slug, createdAt) VALUES ('${TEAM}', 'T', 't', ${now})`,
  );
  db.exec(
    `INSERT INTO member (id, userId, organizationId, role, createdAt) VALUES
     ('m1', '${OWNER}', '${TEAM}', 'owner', ${now}),
     ('m2', '${MEMBER}', '${TEAM}', 'member', ${now})`,
  );
}

/** The management routes as tenantMiddleware would leave them: user + team resolved. */
function manageApp(userId: string, role: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    const ctx = c as any;
    ctx.set("user", {
      id: userId,
      email: `${userId}@example.com`,
      name: userId,
      role: null,
      activeOrganizationId: TEAM,
    });
    ctx.set("teamId", TEAM);
    ctx.set("teamSlug", "t");
    ctx.set("memberRole", role);
    ctx.set("auditCtx", auditCtx);
    return next();
  });
  app.route("/integrations/cloudflare", cloudflareConnection);
  return app;
}

function callbackApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    (c as any).set("auditCtx", auditCtx);
    return next();
  });
  app.route("/oauth/cloudflare", cloudflareOAuthCallback);
  return app;
}

function signIn(userId: string | null) {
  session.current = userId
    ? { user: { id: userId, email: `${userId}@example.com`, name: userId } }
    : null;
}

/** Cloudflare's token + accounts endpoints. Returns the mock to inspect calls. */
function mockCloudflare(token: Record<string, unknown> = {}) {
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === "https://dash.cloudflare.com/oauth2/token") {
      return Response.json({
        access_token: "cf-access",
        refresh_token: "cf-refresh",
        expires_in: 3600,
        scope: "offline_access access.write",
        ...token,
      });
    }
    if (url.startsWith("https://api.cloudflare.com/client/v4/accounts")) {
      return Response.json({ success: true, result: [{ id: "acc-1", name: "Customer Inc" }] });
    }
    if (url === "https://dash.cloudflare.com/oauth2/revoke")
      return new Response(null, { status: 200 });
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function startAuthorize(returnTo?: string) {
  const res = await manageApp(OWNER, "owner").request(
    "/integrations/cloudflare/authorize",
    {
      method: "POST",
      body: JSON.stringify({ returnTo }),
      headers: { "content-type": "application/json" },
    },
    env,
  );
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  return new URL(url).searchParams.get("state")!;
}

async function callback(query: Record<string, string>) {
  const res = await callbackApp().request(
    `/oauth/cloudflare/callback?${new URLSearchParams(query)}`,
    {},
    env,
  );
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

function connectionRow() {
  return t.db.db.prepare("SELECT * FROM cloudflare_connection WHERE teamId = ?").get(TEAM) as
    | Record<string, any>
    | undefined;
}

beforeEach(() => {
  t = createLocalTestEnv();
  env = {
    ...t.env,
    BETTER_AUTH_URL: "https://api.creek.dev",
    DASHBOARD_URL: "https://app.creek.dev",
    ENCRYPTION_KEY: "test-encryption-key",
    CLOUDFLARE_OAUTH_CLIENT_ID: "creek-client",
    CLOUDFLARE_OAUTH_CLIENT_SECRET: "s3cret",
  };
  seed();
  signIn(OWNER);
});

afterEach(() => {
  vi.unstubAllGlobals();
  t.cleanup();
});

describe("POST /integrations/cloudflare/authorize", () => {
  it("returns a consent URL whose state and PKCE verifier are stored for the callback", async () => {
    const res = await manageApp(OWNER, "owner").request(
      "/integrations/cloudflare/authorize",
      { method: "POST" },
      env,
    );
    const { url } = (await res.json()) as { url: string };
    const u = new URL(url);
    expect(u.origin).toBe("https://dash.cloudflare.com");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://api.creek.dev/oauth/cloudflare/callback",
    );
    expect(u.searchParams.get("scope")).toContain("access.write");

    const row = t.db.db
      .prepare("SELECT * FROM cloudflare_oauth_state WHERE state = ?")
      .get(u.searchParams.get("state")) as any;
    expect(row).toMatchObject({ teamId: TEAM, userId: OWNER, returnTo: null });
    expect(await pkceChallenge(row.codeVerifier)).toBe(u.searchParams.get("code_challenge"));
  });

  it("refuses a team member without domain:manage", async () => {
    const res = await manageApp(MEMBER, "member").request(
      "/integrations/cloudflare/authorize",
      { method: "POST" },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("refuses API keys", async () => {
    const res = await manageApp(OWNER, "owner").request(
      "/integrations/cloudflare/authorize",
      { method: "POST", headers: { "x-api-key": "ck_whatever" } },
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "api_key_not_allowed" });
  });

  it("answers 503 when no OAuth client is configured", async () => {
    env.CLOUDFLARE_OAUTH_CLIENT_ID = undefined;
    const res = await manageApp(OWNER, "owner").request(
      "/integrations/cloudflare/authorize",
      { method: "POST" },
      env,
    );
    expect(res.status).toBe(503);
  });

  it.each(["https://evil.example/x", "//evil.example/x", "/\\evil.example", "settings"])(
    "drops an unsafe returnTo %s",
    async (returnTo) => {
      const state = await startAuthorize(returnTo);
      const row = t.db.db
        .prepare("SELECT returnTo FROM cloudflare_oauth_state WHERE state = ?")
        .get(state) as any;
      expect(row.returnTo).toBeNull();
    },
  );
});

describe("GET /oauth/cloudflare/callback", () => {
  it("stores the encrypted grant and sends the user back to the dashboard", async () => {
    const fetch = mockCloudflare();
    const state = await startAuthorize("/settings/integrations?tab=cf");
    const verifier = (
      t.db.db
        .prepare("SELECT codeVerifier FROM cloudflare_oauth_state WHERE state = ?")
        .get(state) as any
    ).codeVerifier;

    const location = await callback({ state, code: "auth-code" });
    expect(location.origin + location.pathname).toBe("https://app.creek.dev/settings/integrations");
    expect(location.searchParams.get("tab")).toBe("cf");
    expect(location.searchParams.get("cloudflare")).toBe("connected");

    // The code was exchanged with the verifier from this request.
    const tokenBody = new URLSearchParams(String(fetch.mock.calls[0][1]?.body));
    expect(tokenBody.get("code")).toBe("auth-code");
    expect(tokenBody.get("code_verifier")).toBe(verifier);

    const row = connectionRow()!;
    expect(row.connectedByUserId).toBe(OWNER);
    expect(row.grantedScopes).toBe("offline_access access.write");
    expect(JSON.parse(row.accounts)).toEqual([{ id: "acc-1", name: "Customer Inc" }]);
    expect(row.encryptedAccessToken).not.toContain("cf-access");
    expect(row.encryptedRefreshToken).not.toContain("cf-refresh");

    const audit = t.db.db.prepare("SELECT action FROM audit_log").all() as any[];
    expect(audit.map((a) => a.action)).toContain("integration.cloudflare.connect");
  });

  it("sends a flow without returnTo to the dashboard's /settings page", async () => {
    mockCloudflare();
    const location = await callback({ state: await startAuthorize(), code: "c" });
    expect(location.origin + location.pathname).toBe("https://app.creek.dev/settings");
    const unknown = await callback({ state: "no-such-state", code: "c" });
    expect(unknown.pathname).toBe("/settings");
  });

  it("is single-use: replaying the state is refused", async () => {
    mockCloudflare();
    const state = await startAuthorize();
    await callback({ state, code: "c" });
    const replay = await callback({ state, code: "c" });
    expect(replay.searchParams.get("cloudflare_error")).toBe("invalid_state");
  });

  it("refuses a browser signed in as someone other than who started the flow", async () => {
    const fetch = mockCloudflare();
    const state = await startAuthorize();
    signIn(OTHER);
    const location = await callback({ state, code: "c" });
    expect(location.searchParams.get("cloudflare_error")).toBe("session_mismatch");
    expect(fetch).not.toHaveBeenCalled();
    expect(connectionRow()).toBeUndefined();
  });

  it("refuses a signed-out browser", async () => {
    mockCloudflare();
    const state = await startAuthorize();
    signIn(null);
    expect((await callback({ state, code: "c" })).searchParams.get("cloudflare_error")).toBe(
      "session_mismatch",
    );
  });

  it("refuses when the starter lost domain:manage during consent", async () => {
    mockCloudflare();
    const state = await startAuthorize();
    t.db.db.exec(`UPDATE member SET role = 'member' WHERE userId = '${OWNER}'`);
    expect((await callback({ state, code: "c" })).searchParams.get("cloudflare_error")).toBe(
      "forbidden",
    );
  });

  it("reports a denied consent", async () => {
    mockCloudflare();
    const state = await startAuthorize();
    const location = await callback({ state, error: "access_denied" });
    expect(location.searchParams.get("cloudflare_error")).toBe("denied");
    expect(connectionRow()).toBeUndefined();
  });

  it("refuses an expired request", async () => {
    mockCloudflare();
    const state = await startAuthorize();
    t.db.db.exec(`UPDATE cloudflare_oauth_state SET expiresAt = 1`);
    expect((await callback({ state, code: "c" })).searchParams.get("cloudflare_error")).toBe(
      "expired",
    );
  });

  it("reports a failed code exchange", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })),
    );
    const state = await startAuthorize();
    expect((await callback({ state, code: "c" })).searchParams.get("cloudflare_error")).toBe(
      "token_exchange_failed",
    );
  });
});

describe("GET/DELETE /integrations/cloudflare", () => {
  async function connect() {
    mockCloudflare();
    await callback({ state: await startAuthorize(), code: "c" });
  }

  it("shows the connection without any token", async () => {
    await connect();
    const res = await manageApp(MEMBER, "member").request("/integrations/cloudflare", {}, env);
    const body = await res.json();
    expect(body).toMatchObject({
      configured: true,
      connected: true,
      accounts: [{ id: "acc-1", name: "Customer Inc" }],
      grantedScopes: ["offline_access", "access.write"],
      needsReauth: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/cf-access|cf-refresh|encrypted/);
  });

  it("shows connected: false before connecting", async () => {
    const res = await manageApp(OWNER, "owner").request("/integrations/cloudflare", {}, env);
    expect(await res.json()).toEqual({ configured: true, connected: false });
  });

  it("disconnects and revokes the refresh token at Cloudflare", async () => {
    await connect();
    const fetch = mockCloudflare();
    const res = await manageApp(OWNER, "owner").request(
      "/integrations/cloudflare",
      { method: "DELETE" },
      env,
    );
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect(connectionRow()).toBeUndefined();
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://dash.cloudflare.com/oauth2/revoke");
    expect(new URLSearchParams(String(init?.body)).get("token")).toBe("cf-refresh");
  });

  it("answers 404 when nothing is connected", async () => {
    const res = await manageApp(OWNER, "owner").request(
      "/integrations/cloudflare",
      { method: "DELETE" },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("refuses a member", async () => {
    await connect();
    const res = await manageApp(MEMBER, "member").request(
      "/integrations/cloudflare",
      { method: "DELETE" },
      env,
    );
    expect(res.status).toBe(403);
    expect(connectionRow()).toBeDefined();
  });
});

describe("getCloudflareAccessToken", () => {
  const config = () => store.oauthConfig(env)!;

  async function saveWith(tokens: Partial<Parameters<typeof store.saveConnection>[3]>) {
    await store.saveConnection(
      env,
      TEAM,
      OWNER,
      {
        accessToken: "at1",
        refreshToken: "rt1",
        expiresAt: Date.now() + 3600_000,
        scopes: ["access.write"],
        ...tokens,
      },
      [],
    );
  }

  it("returns a fresh token without calling Cloudflare", async () => {
    const fetch = mockCloudflare();
    await saveWith({});
    expect(await store.getCloudflareAccessToken(env, config(), TEAM)).toBe("at1");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token and persists the rotated refresh token", async () => {
    await saveWith({ expiresAt: Date.now() + 10_000 });
    const fetch = mockCloudflare({ access_token: "at2", refresh_token: "rt2" });
    const before = connectionRow()!.generation;

    expect(await store.getCloudflareAccessToken(env, config(), TEAM)).toBe("at2");
    expect(new URLSearchParams(String(fetch.mock.calls[0][1]?.body)).get("refresh_token")).toBe(
      "rt1",
    );
    const row = connectionRow()!;
    expect(row.generation).not.toBe(before);
    expect(row.refreshLeaseUntil).toBeNull();

    // The next refresh spends rt2, not rt1.
    t.db.db.exec(`UPDATE cloudflare_connection SET accessTokenExpiresAt = 1`);
    mockCloudflare({ access_token: "at3", refresh_token: "rt3" });
    const f2 = vi.mocked(globalThis.fetch);
    expect(await store.getCloudflareAccessToken(env, config(), TEAM)).toBe("at3");
    expect(new URLSearchParams(String(f2.mock.calls[0][1]?.body)).get("refresh_token")).toBe("rt2");
  });

  it("refreshes once when many requests need a token at the same time", async () => {
    await saveWith({ expiresAt: 1 });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return Response.json({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 });
      }),
    );
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
    const tokens = await Promise.all(
      Array.from({ length: 5 }, () =>
        // PBKDF2 key derivation makes the winner take ~100ms+: allow waiters ~2s.
        store.getCloudflareAccessToken(env, config(), TEAM, { sleep, maxWaits: 400 }),
      ),
    );
    expect(tokens).toEqual(["at2", "at2", "at2", "at2", "at2"]);
    expect(calls).toBe(1);
  });

  it("drops a refresh token Cloudflare rejects and reports needsReauth", async () => {
    await saveWith({ expiresAt: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })),
    );
    await expect(store.getCloudflareAccessToken(env, config(), TEAM)).rejects.toBeInstanceOf(
      store.CloudflareReauthRequiredError,
    );
    expect(connectionRow()!.encryptedRefreshToken).toBeNull();
    expect((await store.getConnectionStatus(env.DB, TEAM))!.needsReauth).toBe(true);
  });

  it.each([
    [429, "rate_limited"],
    [401, "invalid_client"],
  ])(
    "keeps the refresh token on a %i %s (only invalid_grant means it is spent)",
    async (status, error) => {
      await saveWith({ expiresAt: 1 });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error }, { status })),
      );
      const err = await store.getCloudflareAccessToken(env, config(), TEAM).catch((e) => e);
      expect(err).not.toBeInstanceOf(store.CloudflareReauthRequiredError);
      expect(connectionRow()!.encryptedRefreshToken).not.toBeNull();
      expect(connectionRow()!.refreshLeaseUntil).toBeNull();
      expect((await store.getConnectionStatus(env.DB, TEAM))!.needsReauth).toBe(false);
    },
  );

  it("releases the lease when Cloudflare is unreachable, so the next call retries", async () => {
    await saveWith({ expiresAt: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network down"))),
    );
    await expect(store.getCloudflareAccessToken(env, config(), TEAM)).rejects.toThrow(
      "network down",
    );
    expect(connectionRow()!.refreshLeaseUntil).toBeNull();
    expect(connectionRow()!.encryptedRefreshToken).not.toBeNull();
  });

  describe("a refresh that straddles a disconnect and reconnect", () => {
    /** Mid-refresh, the team disconnects and connects again (a brand-new grant). */
    function refreshThatReconnects(response: () => Response) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          await store.deleteConnection(env, TEAM);
          await saveWith({ accessToken: "new-at", refreshToken: "new-rt" });
          return response();
        }),
      );
    }

    it("does not overwrite the new grant with the old grant's tokens", async () => {
      await saveWith({ expiresAt: 1 });
      refreshThatReconnects(() =>
        Response.json({ access_token: "stale-at", refresh_token: "stale-rt", expires_in: 3600 }),
      );
      await store.getCloudflareAccessToken(env, config(), TEAM);
      expect(await store.getCloudflareAccessToken(env, config(), TEAM)).toBe("new-at");
    });

    it("does not drop the new grant's refresh token when the old one was rejected", async () => {
      await saveWith({ expiresAt: 1 });
      refreshThatReconnects(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
      await store.getCloudflareAccessToken(env, config(), TEAM).catch(() => {});
      expect(connectionRow()!.encryptedRefreshToken).not.toBeNull();
    });
  });

  it("throws CloudflareNotConnectedError for a team without a grant", async () => {
    await expect(store.getCloudflareAccessToken(env, config(), TEAM)).rejects.toBeInstanceOf(
      store.CloudflareNotConnectedError,
    );
  });
});
