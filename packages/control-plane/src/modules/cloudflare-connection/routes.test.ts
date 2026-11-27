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
const { pkceChallenge } = await import("./oauth.js");
const { createInMemoryGrantNamespace } = await import("./grant-object.js");

const TEAM = "team-1";
const OWNER = "user-owner";
const MEMBER = "user-member";
const OTHER = "user-other";
const auditCtx = { ip: "1.2.3.4", ipHash: "h", country: null, userAgent: null, cfRay: null };

let t: LocalTestEnv;
let env: Env;
let grants: ReturnType<typeof createInMemoryGrantNamespace>;

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

/** The team's status row in D1 (never a token). */
function grantRow() {
  return t.db.db.prepare("SELECT * FROM cloudflare_grant WHERE teamId = ?").get(TEAM) as
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
  grants = createInMemoryGrantNamespace(env);
  env.CLOUDFLARE_GRANTS = grants;
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

    const row = grantRow()!;
    expect(row.connectedByUserId).toBe(OWNER);
    expect(row.grantedScopes).toBe("offline_access access.write");
    expect(JSON.parse(row.accounts)).toEqual([{ id: "acc-1", name: "Customer Inc" }]);
    expect(row.needsReauth).toBe(0);
    // The tokens live in the team's grant object, encrypted, and nowhere in D1.
    const stored = grants._stored(TEAM)!;
    expect(stored.encryptedAccessToken).not.toContain("cf-access");
    expect(stored.encryptedRefreshToken).not.toContain("cf-refresh");
    expect(JSON.stringify(row)).not.toMatch(/cf-access|cf-refresh/);

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
    expect(grantRow()).toBeUndefined();
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
    expect(grantRow()).toBeUndefined();
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
    expect(grantRow()).toBeUndefined();
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
    expect(grantRow()).toBeDefined();
  });
});

describe("POST /integrations/cloudflare/verify", () => {
  async function connect(token: Record<string, unknown> = {}) {
    mockCloudflare(token);
    await callback({ state: await startAuthorize(), code: "c" });
  }
  const verify = () =>
    manageApp(MEMBER, "member").request("/integrations/cloudflare/verify", { method: "POST" }, env);

  it("reaches Cloudflare with the team's token", async () => {
    await connect();
    const fetch = mockCloudflare();
    const res = await verify();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      accounts: [{ id: "acc-1", name: "Customer Inc" }],
    });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("authorization")).toBe(
      "Bearer cf-access",
    );
  });

  it("refreshes an expired token first", async () => {
    await connect({ expires_in: 0 });
    const fetch = mockCloudflare({ access_token: "cf-access-2", refresh_token: "cf-refresh-2" });
    expect((await verify()).status).toBe(200);
    expect(String(fetch.mock.calls[0][0])).toBe("https://dash.cloudflare.com/oauth2/token");
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get("authorization")).toBe(
      "Bearer cf-access-2",
    );
  });

  it("answers 404 before connecting", async () => {
    expect((await verify()).status).toBe(404);
  });

  it("answers 409 and marks needsReauth when Cloudflare refuses the refresh token", async () => {
    await connect({ expires_in: 0 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })),
    );
    const res = await verify();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "reauth_required" });
    expect(grantRow()!.needsReauth).toBe(1);
  });
});

describe("disconnect", () => {
  it("forgets the tokens, so a later token request finds no grant", async () => {
    mockCloudflare();
    await callback({ state: await startAuthorize(), code: "c" });
    await manageApp(OWNER, "owner").request("/integrations/cloudflare", { method: "DELETE" }, env);
    expect(grants._stored(TEAM)).toBeUndefined();
    const res = await manageApp(OWNER, "owner").request(
      "/integrations/cloudflare/verify",
      { method: "POST" },
      env,
    );
    expect(res.status).toBe(404);
  });
});
