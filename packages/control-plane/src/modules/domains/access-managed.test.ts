import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createLocalTestEnv, seedTestData, type LocalTestEnv } from "../../local/test-env.js";
import { createTestApp, TEST_USER, TEST_TEAM } from "../../test-helpers.js";
import { grantClient } from "../cloudflare-connection/grant-object.js";
import { parseManagedInput, readManaged } from "./access-managed.js";

/**
 * PUT /projects/:id/access/managed: Creek makes the Access applications in the
 * team's own Cloudflare account. Cloudflare is a fake that behaves as the real
 * API did when probed on 2026-11-28 (inline policies are replaced on update,
 * the AUD survives an update, a missing app is a 404).
 */

const PROJECT_ID = "proj-1";
const ACCOUNT = "a".repeat(32);
const OTHER_ACCOUNT = "b".repeat(32);
const CF_TOKEN = "cf-access-token";
const TEAM_DOMAIN = "acme-zt.cloudflareaccess.com";
const ALL_SCOPES = ["access.write", "access-acct.read", "access-acct.write"];

interface FakeApp {
  aud: string;
  body: any;
}

let testEnv: LocalTestEnv;
let app: ReturnType<typeof createTestApp>;
const originalFetch = globalThis.fetch;

/** The fake Cloudflare account. */
let cf: {
  org: string | null;
  idps: number;
  apps: Map<string, FakeApp>;
  calls: string[];
  /** Runs on every call before it is answered: lets a test act mid-request. */
  onCall?: (method: string, path: string) => void;
  /** Refuse matching calls; with `skip`, only after letting that many through. */
  fail: {
    method: string;
    path: RegExp;
    status: number;
    message?: string;
    skip?: number;
  } | null;
};
let nextId = 0;

function cfJson(status: number, body: unknown) {
  return Response.json(body, { status });
}

function fakeCloudflare(method: string, path: string, body: any): Response {
  cf.calls.push(`${method} ${path}`);
  cf.onCall?.(method, path);
  if (cf.fail && cf.fail.method === method && cf.fail.path.test(path)) {
    if (cf.fail.skip) {
      cf.fail.skip--;
      return fakeAccount(method, path, body);
    }
    const { status, message } = cf.fail;
    return cfJson(status, {
      success: false,
      errors: [{ code: 1, message: message ?? "refused" }],
    });
  }
  return fakeAccount(method, path, body);
}

function fakeAccount(method: string, path: string, body: any): Response {
  const base = `/client/v4/accounts/${ACCOUNT}/access`;
  if (!path.startsWith(base)) {
    return cfJson(403, {
      success: false,
      errors: [{ code: 10000, message: "Authentication error" }],
    });
  }
  const rest = path.slice(base.length);
  if (rest === "/organizations") {
    if (method === "GET") {
      return cf.org
        ? cfJson(200, {
            success: true,
            result: { auth_domain: cf.org, name: "x" },
          })
        : cfJson(404, {
            success: false,
            errors: [{ code: 12130, message: "not found" }],
          });
    }
    cf.org = TEAM_DOMAIN;
    return cfJson(200, {
      success: true,
      result: { auth_domain: cf.org, name: body.name },
    });
  }
  if (rest === "/identity_providers") {
    if (method === "GET") {
      return cfJson(200, {
        success: true,
        result: Array.from({ length: cf.idps }, () => ({})),
      });
    }
    cf.idps++;
    return cfJson(200, {
      success: true,
      result: { id: "idp", type: body.type },
    });
  }
  if (rest === "/apps" && method === "POST") {
    const id = `app-${++nextId}`;
    const aud = nextId.toString(16).padStart(64, "0");
    cf.apps.set(id, { aud, body });
    return cfJson(200, { success: true, result: { id, aud } });
  }
  const m = rest.match(/^\/apps\/([^/]+)$/);
  if (m) {
    const existing = cf.apps.get(m[1]!);
    if (!existing)
      return cfJson(404, {
        success: false,
        errors: [{ code: 12130, message: "not found" }],
      });
    if (method === "PUT") {
      existing.body = body;
      return cfJson(200, {
        success: true,
        result: { id: m[1], aud: existing.aud },
      });
    }
    if (method === "DELETE") {
      cf.apps.delete(m[1]!);
      return cfJson(200, { success: true, result: { id: m[1] } });
    }
  }
  return cfJson(400, {
    success: false,
    errors: [{ code: 1, message: `unexpected ${method} ${rest}` }],
  });
}

async function connect(scopes = ALL_SCOPES, accounts = [{ id: ACCOUNT, name: "Acme" }]) {
  await grantClient(testEnv.env, TEST_TEAM.id).connect({
    teamId: TEST_TEAM.id,
    userId: TEST_USER.id,
    tokens: {
      accessToken: CF_TOKEN,
      refreshToken: null,
      expiresAt: Date.now() + 3600_000,
      scopes,
    },
    accounts,
  });
}

function addDomain(hostname: string, isPrimary = false) {
  testEnv.db.db.exec(
    `INSERT INTO custom_domain (id, projectId, hostname, status, isPrimary, createdAt)
     VALUES ('d-${hostname}', '${PROJECT_ID}', '${hostname}', 'active', ${isPrimary ? 1 : 0}, ${Date.now()})`,
  );
}

beforeEach(async () => {
  testEnv = createLocalTestEnv();
  seedTestData(testEnv);
  testEnv.env.ENCRYPTION_KEY = "test-encryption-key";
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
  const now = Date.now();
  testEnv.db.db.exec(
    `INSERT INTO project (id, slug, organizationId, productionBranch, createdAt, updatedAt) VALUES
       ('${PROJECT_ID}', 'my-app', '${TEST_TEAM.id}', 'main', ${now}, ${now})`,
  );
  addDomain("app.acme.com", true);
  cf = { org: TEAM_DOMAIN, idps: 1, apps: new Map(), calls: [], fail: null };
  nextId = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.hostname === "api.cloudflare.com") {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== `Bearer ${CF_TOKEN}`) {
        return cfJson(401, {
          success: false,
          errors: [{ code: 10000, message: "bad token" }],
        });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return fakeCloudflare(init?.method ?? "GET", url.pathname, body);
    }
    return originalFetch(input as any, init);
  }) as any;
});

afterEach(() => {
  testEnv.cleanup();
  globalThis.fetch = originalFetch;
});

function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, testEnv.env);
}

const put = (body: unknown) => req("PUT", `/projects/${PROJECT_ID}/access/managed`, body);

const stored = () =>
  testEnv.db.db
    .prepare(
      "SELECT accessTeamDomain, accessAud, accessBypassPaths, accessManaged FROM project WHERE id = ?",
    )
    .get(PROJECT_ID) as Record<string, string | null>;

const auditActions = () =>
  testEnv.db.db
    .prepare("SELECT action FROM audit_log ORDER BY rowid")
    .all()
    .map((r: any) => r.action);

const mutations = () => cf.calls.filter((c) => !c.startsWith("GET"));

describe("PUT /projects/:id/access/managed", () => {
  test("creates the application on every custom domain and protects the project with it", async () => {
    await connect();
    addDomain("www.acme.com");
    const res = await put({
      emails: ["Bob@Example.com"],
      emailDomains: ["@acme.com"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      protected: true,
      teamDomain: TEAM_DOMAIN,
      hostnames: ["app.acme.com", "www.acme.com"],
      managed: {
        accountId: ACCOUNT,
        emails: ["bob@example.com"],
        emailDomains: ["acme.com"],
        teamMembers: false,
      },
    });

    expect(cf.apps.size).toBe(1);
    const [[appId, created]] = [...cf.apps];
    expect(created.body).toMatchObject({
      type: "self_hosted",
      domain: "app.acme.com",
      destinations: [
        { type: "public", uri: "app.acme.com" },
        { type: "public", uri: "www.acme.com" },
      ],
      policies: [
        {
          decision: "allow",
          include: [
            { email: { email: "bob@example.com" } },
            { email_domain: { domain: "acme.com" } },
          ],
        },
      ],
    });

    const row = stored();
    expect(row.accessTeamDomain).toBe(TEAM_DOMAIN);
    expect(row.accessAud).toBe(created.aud);
    expect(row.accessBypassPaths).toBe("[]");
    expect(readManaged(row.accessManaged)).toMatchObject({
      appId,
      bypassAppId: null,
    });
    expect(auditActions()).toEqual(["domain.access_update"]);

    const get = (await (await req("GET", `/projects/${PROJECT_ID}/access`)).json()) as any;
    expect(get).toMatchObject({
      protected: true,
      aud: created.aud,
      managed: body.managed,
    });
    expect(JSON.stringify(get)).not.toContain(CF_TOKEN);
  });

  test("saving again updates the same application in place and keeps its AUD", async () => {
    await connect();
    await put({ emails: ["a@example.com"] });
    const firstAud = stored().accessAud;
    cf.calls = [];

    const res = await put({ emailDomains: ["acme.com"] });
    expect(res.status).toBe(200);
    expect(mutations()).toEqual([`PUT /client/v4/accounts/${ACCOUNT}/access/apps/app-1`]);
    expect(cf.apps.get("app-1")!.body.policies[0].include).toEqual([
      { email_domain: { domain: "acme.com" } },
    ]);
    expect(stored().accessAud).toBe(firstAud);
  });

  test("bypass paths get a second application on every host and path; clearing them deletes it", async () => {
    await connect();
    addDomain("www.acme.com");
    await put({
      emails: ["a@example.com"],
      bypassPaths: ["/health", "/api/hooks/*"],
    });

    const { bypassAppId, appId } = readManaged(stored().accessManaged)!;
    expect(bypassAppId).not.toBeNull();
    expect(cf.apps.get(appId)!.body.policies[0].decision).toBe("allow");
    const bypass = cf.apps.get(bypassAppId!)!;
    expect(bypass.body.destinations.map((d: any) => d.uri)).toEqual([
      "app.acme.com/health",
      "app.acme.com/api/hooks/*",
      "www.acme.com/health",
      "www.acme.com/api/hooks/*",
    ]);
    expect(bypass.body.policies).toEqual([
      expect.objectContaining({
        decision: "bypass",
        include: [{ everyone: {} }],
      }),
    ]);
    expect(stored().accessBypassPaths).toBe('["/health","/api/hooks/*"]');

    await put({ emails: ["a@example.com"] });
    expect(cf.apps.has(bypassAppId!)).toBe(false);
    expect(cf.apps.has(appId)).toBe(true);
    expect(readManaged(stored().accessManaged)!.bypassAppId).toBeNull();
    expect(stored().accessBypassPaths).toBe("[]");
  });

  test("an application deleted at Cloudflare is made again, with its new AUD saved", async () => {
    await connect();
    await put({ emails: ["a@example.com"] });
    cf.apps.clear();
    const res = await put({ emails: ["a@example.com"] });
    expect(res.status).toBe(200);
    expect([...cf.apps.keys()]).toEqual(["app-2"]);
    expect(stored().accessAud).toBe(cf.apps.get("app-2")!.aud);
  });

  test("teamMembers adds the Creek team's members' emails", async () => {
    await connect();
    const res = await put({ teamMembers: true });
    expect(res.status).toBe(200);
    expect(cf.apps.get("app-1")!.body.policies[0].include).toEqual([
      { email: { email: TEST_USER.email } },
    ]);
  });

  test("sets up Zero Trust and One-time PIN when the account has neither", async () => {
    cf.org = null;
    cf.idps = 0;
    await connect();
    const res = await put({ emails: ["a@example.com"] });
    expect(res.status).toBe(200);
    expect(mutations().slice(0, 2)).toEqual([
      `POST /client/v4/accounts/${ACCOUNT}/access/organizations`,
      `POST /client/v4/accounts/${ACCOUNT}/access/identity_providers`,
    ]);
    expect(stored().accessTeamDomain).toBe(TEAM_DOMAIN);
  });

  test("without access-acct.write, no Zero Trust: 409 with the setup link, nothing created", async () => {
    cf.org = null;
    await connect(["access.write", "access-acct.read"]);
    const res = await put({ emails: ["a@example.com"] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toBe("zero_trust_setup_required");
    expect(body.setupUrl).toBe(`https://dash.cloudflare.com/${ACCOUNT}/one/onboarding`);
    expect(mutations()).toEqual([]);
    expect(stored().accessAud).toBeNull();
  });

  test("without access-acct.write, no login method: 409 login_method_required", async () => {
    cf.idps = 0;
    await connect(["access.write", "access-acct.read"]);
    const res = await put({ emails: ["a@example.com"] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe("login_method_required");
    expect(mutations()).toEqual([]);
  });

  test("another save landing mid-request wins; this request's applications are deleted", async () => {
    await connect();
    const theirs = JSON.stringify({ accountId: ACCOUNT, appId: "app-theirs", bypassAppId: null });
    cf.onCall = (method, path) => {
      if (method === "POST" && path.endsWith("/apps")) {
        testEnv.db.db
          .prepare("UPDATE project SET accessAud = ?, accessManaged = ? WHERE id = ?")
          .run("ef".repeat(32), theirs, PROJECT_ID);
      }
    };
    const res = await put({ emails: ["a@example.com"] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe("conflict");
    expect(cf.apps.size).toBe(0);
    expect(stored().accessManaged).toBe(theirs);
    expect(auditActions()).toEqual([]);
  });

  test("a managed save landing during a customer-app PUT is not overwritten", async () => {
    await connect();
    const theirs = JSON.stringify({ accountId: ACCOUNT, appId: "app-theirs", bypassAppId: null });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/cdn-cgi/access/certs")) {
        // The keys check runs between the managed_by_creek check and the save.
        testEnv.db.db
          .prepare("UPDATE project SET accessManaged = ? WHERE id = ?")
          .run(theirs, PROJECT_ID);
        return Response.json({ keys: [{ kid: "k1" }] });
      }
      return originalFetch(input as any);
    }) as any;
    const res = await req("PUT", `/projects/${PROJECT_ID}/access`, {
      teamDomain: "other.cloudflareaccess.com",
      aud: "cd".repeat(32),
    });
    expect(res.status).toBe(409);
    expect(stored().accessManaged).toBe(theirs);
    expect(stored().accessAud).toBeNull();
  });

  test("a failure after creating applications deletes them and saves nothing", async () => {
    await connect();
    // The main application is made; the bypass one is refused.
    cf.fail = {
      method: "POST",
      path: /\/apps$/,
      status: 400,
      message: "too many destinations",
      skip: 1,
    };

    const res = await put({
      emails: ["a@example.com"],
      bypassPaths: ["/health"],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("cloudflare_rejected");
    expect(body.message).toContain("too many destinations");
    expect(cf.apps.size).toBe(0);
    expect(stored().accessAud).toBeNull();
    expect(auditActions()).toEqual([]);
  });

  test("a Cloudflare permission refusal is a 409 that says to reconnect", async () => {
    await connect();
    cf.fail = {
      method: "POST",
      path: /\/apps$/,
      status: 403,
      message: "Authentication error",
    };
    const res = await put({ emails: ["a@example.com"] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe("cloudflare_forbidden");
  });

  test("a project without a custom domain: 400 no_custom_domain, Cloudflare untouched", async () => {
    await connect();
    testEnv.db.db.exec("DELETE FROM custom_domain");
    const res = await put({ emails: ["a@example.com"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("no_custom_domain");
    expect(cf.calls).toEqual([]);
  });

  test("Cloudflare not connected: 409 cloudflare_not_connected", async () => {
    const res = await put({ emails: ["a@example.com"] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe("cloudflare_not_connected");
  });

  test("a grant on several accounts needs accountId, and only a granted one", async () => {
    await connect(ALL_SCOPES, [
      { id: ACCOUNT, name: "Acme" },
      { id: OTHER_ACCOUNT, name: "Other" },
    ]);
    const none = await put({ emails: ["a@example.com"] });
    expect(none.status).toBe(400);
    const noneBody = (await none.json()) as any;
    expect(noneBody.error).toBe("account_required");
    expect(noneBody.accounts).toHaveLength(2);

    const foreign = await put({
      emails: ["a@example.com"],
      accountId: "c".repeat(32),
    });
    expect(((await foreign.json()) as any).error).toBe("account_not_granted");

    const ok = await put({ emails: ["a@example.com"], accountId: ACCOUNT });
    expect(ok.status).toBe(200);
    // Once set, the account is remembered…
    expect((await put({ emails: ["b@example.com"] })).status).toBe(200);
    // …and cannot silently move.
    const moved = await put({
      emails: ["a@example.com"],
      accountId: OTHER_ACCOUNT,
    });
    expect(moved.status).toBe(409);
    expect(((await moved.json()) as any).error).toBe("account_change");
  });

  test("a member without domain:manage cannot provision", async () => {
    await connect();
    testEnv.db.db.exec("UPDATE member SET role = 'member'");
    expect((await put({ emails: ["a@example.com"] })).status).toBe(403);
    expect(cf.calls).toEqual([]);
  });

  test.each([
    [{}, "Say who may get in"],
    [{ emails: ["not-an-email"] }, "Invalid email"],
    [{ emailDomains: ["acme"] }, "Invalid email domain"],
    [{ emails: ["a@example.com"], bypassPaths: ["/"] }, "Invalid bypass path"],
    [{ emails: ["a@example.com"], accountId: "nope" }, "accountId"],
    [{ teamMembers: "yes" }, "teamMembers"],
  ])("refuses %j", async (body, message) => {
    await connect();
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).message).toContain(message);
    expect(cf.calls).toEqual([]);
  });
});

describe("ordering and the lease", () => {
  test("a failure at the bypass step leaves the allow-list as it was", async () => {
    await connect();
    await put({ emails: ["a@example.com"], bypassPaths: ["/health"] });
    const { appId, bypassAppId } = readManaged(stored().accessManaged)!;
    cf.fail = { method: "PUT", path: new RegExp(`/apps/${bypassAppId}$`), status: 400 };

    const res = await put({ emails: ["b@example.com"], bypassPaths: ["/status"] });
    expect(res.status).toBe(400);
    expect(cf.apps.get(appId)!.body.policies[0].include).toEqual([
      { email: { email: "a@example.com" } },
    ]);
  });

  test("a change while another holds the lease: 409 busy, Cloudflare untouched", async () => {
    await connect();
    testEnv.db.db
      .prepare("UPDATE project SET accessLockedUntil = ? WHERE id = ?")
      .run(Date.now() + 60_000, PROJECT_ID);
    for (const res of [
      await put({ emails: ["a@example.com"] }),
      await req("PUT", `/projects/${PROJECT_ID}/access`, {
        teamDomain: TEAM_DOMAIN,
        aud: "cd".repeat(32),
      }),
      await req("DELETE", `/projects/${PROJECT_ID}/access`),
    ]) {
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).error).toBe("busy");
    }
    expect(cf.calls).toEqual([]);
  });

  test("an expired lease is taken over, and every change gives its lease back", async () => {
    await connect();
    const lease = () =>
      (
        testEnv.db.db
          .prepare("SELECT accessLockedUntil FROM project WHERE id = ?")
          .get(PROJECT_ID) as any
      ).accessLockedUntil;
    testEnv.db.db
      .prepare("UPDATE project SET accessLockedUntil = ? WHERE id = ?")
      .run(Date.now() - 1, PROJECT_ID);
    expect((await put({ emails: ["a@example.com"] })).status).toBe(200);
    expect(lease()).toBeNull();

    cf.fail = { method: "PUT", path: /\/apps\//, status: 400 };
    expect((await put({ emails: ["b@example.com"] })).status).toBe(400);
    expect(lease()).toBeNull();
  });
});

describe("DELETE /projects/:id (the project itself)", () => {
  test("deletes Creek's Access applications with the project", async () => {
    await connect();
    await put({ emails: ["a@example.com"], bypassPaths: ["/health"] });
    const res = await req("DELETE", `/projects/${PROJECT_ID}`);
    expect(res.status).toBe(200);
    expect(cf.apps.size).toBe(0);
  });

  test("keeps the project when the applications cannot be deleted", async () => {
    await connect();
    await put({ emails: ["a@example.com"] });
    cf.fail = { method: "DELETE", path: /\/apps\//, status: 500 };
    const res = await req("DELETE", `/projects/${PROJECT_ID}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ error: "access_cleanup_failed", accountId: ACCOUNT });
    expect(body.appIds).toHaveLength(1);
    expect(cf.apps.size).toBe(1);
    expect(stored().accessManaged).not.toBeNull();
  });
});

describe("DELETE /projects/:id/access on a managed project", () => {
  test("deletes Creek's applications, then the settings", async () => {
    await connect();
    await put({ emails: ["a@example.com"], bypassPaths: ["/health"] });
    expect(cf.apps.size).toBe(2);

    const res = await req("DELETE", `/projects/${PROJECT_ID}/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, protected: false });
    expect(cf.apps.size).toBe(0);
    expect(stored()).toEqual({
      accessTeamDomain: null,
      accessAud: null,
      accessBypassPaths: null,
      accessManaged: null,
    });
    expect(auditActions()).toEqual(["domain.access_update", "domain.access_remove"]);
  });

  test("when Cloudflare cannot be reached, protection still comes off and the leftovers are named", async () => {
    await connect();
    await put({ emails: ["a@example.com"] });
    await grantClient(testEnv.env, TEST_TEAM.id).disconnect();

    const res = await req("DELETE", `/projects/${PROJECT_ID}/access`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.protected).toBe(false);
    expect(body.cloudflareCleanup).toMatchObject({
      ok: false,
      accountId: ACCOUNT,
      appIds: ["app-1"],
    });
    expect(stored().accessAud).toBeNull();
    expect(cf.apps.size).toBe(1);
  });
});

describe("PUT /projects/:id/access on a managed project", () => {
  test("is refused, so Creek's applications are never orphaned", async () => {
    await connect();
    await put({ emails: ["a@example.com"] });
    const before = stored();
    const res = await req("PUT", `/projects/${PROJECT_ID}/access`, {
      teamDomain: "other.cloudflareaccess.com",
      aud: "cd".repeat(32),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe("managed_by_creek");
    expect(stored()).toEqual(before);
  });
});

describe("parseManagedInput", () => {
  test("lower-cases, trims and de-duplicates", () => {
    expect(
      parseManagedInput({
        emails: [" A@Example.com", "a@example.com"],
        emailDomains: ["@Acme.com", "acme.com"],
      }),
    ).toEqual({
      ok: true,
      input: {
        accountId: null,
        emails: ["a@example.com"],
        emailDomains: ["acme.com"],
        teamMembers: false,
      },
    });
  });
});
