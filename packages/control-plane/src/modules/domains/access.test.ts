import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createLocalTestEnv, seedTestData, type LocalTestEnv } from "../../local/test-env.js";
import { createTestApp, TEST_USER, TEST_TEAM } from "../../test-helpers.js";
import { normalizeTeamDomain, parseAccessBody } from "./access.js";

/**
 * Access protection settings: what the dispatch worker enforces
 * (packages/dispatch-worker/src/access-enforcement.test.ts).
 */

let testEnv: LocalTestEnv;
let app: ReturnType<typeof createTestApp>;
const originalFetch = globalThis.fetch;
let certsResponse: () => Response;
let certFetches: string[];

const PROJECT_ID = "proj-1";
const TEAM_DOMAIN = "acme.cloudflareaccess.com";
const AUD = "ab".repeat(32);

function setup(role?: string) {
  testEnv = createLocalTestEnv();
  seedTestData(testEnv, role ? { role } : undefined);
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
  const now = Date.now();
  testEnv.db.db.exec(
    `INSERT INTO project (id, slug, organizationId, productionBranch, createdAt, updatedAt) VALUES
       ('${PROJECT_ID}', 'my-app', '${TEST_TEAM.id}', 'main', ${now}, ${now})`,
  );
}

beforeEach(() => {
  setup();
  certFetches = [];
  certsResponse = () => Response.json({ keys: [{ kid: "k1", kty: "RSA", n: "x", e: "AQAB" }] });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/cdn-cgi/access/certs")) {
      certFetches.push(url);
      return certsResponse();
    }
    return originalFetch(input as any);
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
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return app.request(path, init, testEnv.env);
}

const stored = () =>
  testEnv.db.db
    .prepare("SELECT accessTeamDomain, accessAud, accessBypassPaths FROM project WHERE id = ?")
    .get(PROJECT_ID) as Record<string, string | null>;

const auditActions = () =>
  testEnv.db.db
    .prepare("SELECT action FROM audit_log ORDER BY rowid")
    .all()
    .map((r: any) => r.action);

describe("GET /projects/:id/access", () => {
  test("a new project is not protected", async () => {
    const res = await req("GET", `/projects/${PROJECT_ID}/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ protected: false, hostnames: [] });
  });

  test("unknown project: 404", async () => {
    expect((await req("GET", "/projects/nope/access")).status).toBe(404);
  });
});

describe("PUT /projects/:id/access", () => {
  test("stores the settings, normalised, after checking the team publishes keys", async () => {
    const res = await req("PUT", `/projects/${PROJECT_ID}/access`, {
      teamDomain: "https://ACME.cloudflareaccess.com/",
      aud: AUD.toUpperCase(),
      bypassPaths: ["/health", "/api/webhooks/*", "/health"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      protected: true,
      teamDomain: TEAM_DOMAIN,
      aud: AUD,
      bypassPaths: ["/health", "/api/webhooks/*"],
    });
    expect(stored()).toEqual({
      accessTeamDomain: TEAM_DOMAIN,
      accessAud: AUD,
      accessBypassPaths: '["/health","/api/webhooks/*"]',
    });
    expect(certFetches).toEqual([`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`]);
    expect(auditActions()).toEqual(["domain.access_update"]);

    const get = await req("GET", `/projects/${PROJECT_ID}/access`);
    expect(await get.json()).toEqual({
      protected: true,
      teamDomain: TEAM_DOMAIN,
      aud: AUD,
      bypassPaths: ["/health", "/api/webhooks/*"],
      managed: null,
      hostnames: [],
    });
  });

  test("a bare team name means <name>.cloudflareaccess.com", async () => {
    const res = await req("PUT", `/projects/${PROJECT_ID}/access`, {
      teamDomain: "acme",
      aud: AUD,
    });
    expect(res.status).toBe(200);
    expect(stored().accessTeamDomain).toBe(TEAM_DOMAIN);
    expect(stored().accessBypassPaths).toBe("[]");
  });

  test("a team that publishes no keys is refused, and nothing is stored", async () => {
    certsResponse = () => new Response("not found", { status: 404 });
    const res = await req("PUT", `/projects/${PROJECT_ID}/access`, {
      teamDomain: TEAM_DOMAIN,
      aud: AUD,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("team_not_found");
    expect(stored().accessTeamDomain).toBeNull();
    expect(auditActions()).toEqual([]);
  });

  test("an empty key set is refused too", async () => {
    certsResponse = () => Response.json({ keys: [] });
    const res = await req("PUT", `/projects/${PROJECT_ID}/access`, {
      teamDomain: TEAM_DOMAIN,
      aud: AUD,
    });
    expect(res.status).toBe(400);
  });

  test.each([
    ["no body", undefined],
    ["null", "null"],
    ["a team domain on another host", { teamDomain: "acme.example.com", aud: AUD }],
    ["a short AUD", { teamDomain: TEAM_DOMAIN, aud: "abc" }],
    ["bypass of the whole site", { teamDomain: TEAM_DOMAIN, aud: AUD, bypassPaths: ["/"] }],
    [
      "bypass with a wildcard inside",
      { teamDomain: TEAM_DOMAIN, aud: AUD, bypassPaths: ["/a/*/b"] },
    ],
    ["bypass not a list", { teamDomain: TEAM_DOMAIN, aud: AUD, bypassPaths: "/health" }],
    [
      "too many bypass paths",
      {
        teamDomain: TEAM_DOMAIN,
        aud: AUD,
        bypassPaths: Array.from({ length: 21 }, (_, i) => `/p${i}`),
      },
    ],
  ])("refuses %s with 400 and fetches nothing", async (_name, body) => {
    const res = await req("PUT", `/projects/${PROJECT_ID}/access`, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("validation");
    expect(certFetches).toEqual([]);
    expect(stored().accessTeamDomain).toBeNull();
  });

  test("a member without domain:manage can't turn it on", async () => {
    testEnv.cleanup();
    setup("member");
    const res = await req("PUT", `/projects/${PROJECT_ID}/access`, {
      teamDomain: TEAM_DOMAIN,
      aud: AUD,
    });
    expect(res.status).toBe(403);
    expect(stored().accessTeamDomain).toBeNull();
  });
});

describe("DELETE /projects/:id/access", () => {
  test("turns protection off and records it", async () => {
    await req("PUT", `/projects/${PROJECT_ID}/access`, {
      teamDomain: TEAM_DOMAIN,
      aud: AUD,
      bypassPaths: ["/health"],
    });
    const res = await req("DELETE", `/projects/${PROJECT_ID}/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, protected: false });
    expect(stored()).toEqual({
      accessTeamDomain: null,
      accessAud: null,
      accessBypassPaths: null,
    });
    expect(auditActions()).toEqual(["domain.access_update", "domain.access_remove"]);
  });

  test("a member without domain:manage can't turn it off", async () => {
    testEnv.db.db.exec(
      `UPDATE project SET accessTeamDomain = '${TEAM_DOMAIN}', accessAud = '${AUD}' WHERE id = '${PROJECT_ID}'`,
    );
    const db = testEnv.db.db;
    testEnv.db.db.exec("UPDATE member SET role = 'member'");
    const res = await req("DELETE", `/projects/${PROJECT_ID}/access`);
    expect(res.status).toBe(403);
    expect((db.prepare("SELECT accessAud FROM project").get() as any).accessAud).toBe(AUD);
  });
});

describe("before migration 0016", () => {
  test("every route answers 503 not_available rather than 500", async () => {
    for (const col of ["accessTeamDomain", "accessAud", "accessBypassPaths"]) {
      testEnv.db.db.exec(`ALTER TABLE project DROP COLUMN ${col}`);
    }
    const get = await req("GET", `/projects/${PROJECT_ID}/access`);
    const put = await req("PUT", `/projects/${PROJECT_ID}/access`, {
      teamDomain: TEAM_DOMAIN,
      aud: AUD,
    });
    const del = await req("DELETE", `/projects/${PROJECT_ID}/access`);
    for (const res of [get, put, del]) {
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error).toBe("not_available");
    }
    expect(auditActions()).toEqual([]);
  });
});

describe("before migration 0017", () => {
  test("every route answers 503 not_available rather than 500", async () => {
    testEnv.db.db.exec("ALTER TABLE project DROP COLUMN accessManaged");
    const get = await req("GET", `/projects/${PROJECT_ID}/access`);
    const put = await req("PUT", `/projects/${PROJECT_ID}/access`, {
      teamDomain: TEAM_DOMAIN,
      aud: AUD,
    });
    const managed = await req("PUT", `/projects/${PROJECT_ID}/access/managed`, {
      emails: ["a@example.com"],
    });
    const del = await req("DELETE", `/projects/${PROJECT_ID}/access`);
    for (const res of [get, put, managed, del]) {
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error).toBe("not_available");
    }
    expect(stored().accessAud).toBeNull();
    expect(auditActions()).toEqual([]);
  });
});

describe("parsing", () => {
  test.each([
    ["acme", "acme.cloudflareaccess.com"],
    [" Acme.CloudflareAccess.com ", "acme.cloudflareaccess.com"],
    ["https://acme.cloudflareaccess.com/", "acme.cloudflareaccess.com"],
    ["evil.com", "evil.com"],
  ])("normalizeTeamDomain(%j) = %j", (input, expected) => {
    expect(normalizeTeamDomain(input)).toBe(expected);
  });

  test("the worker and the API agree on bypass paths", () => {
    // Mirrors dispatch-worker's isBypassPath table (access.test.ts).
    for (const bad of ["/", "/*", "//", "health", "/a?b", "/a*b", "/a/../b"]) {
      expect(
        parseAccessBody({
          teamDomain: TEAM_DOMAIN,
          aud: AUD,
          bypassPaths: [bad],
        }).ok,
      ).toBe(false);
    }
    for (const good of ["/health", "/health/", "/api/webhooks/*"]) {
      expect(
        parseAccessBody({
          teamDomain: TEAM_DOMAIN,
          aud: AUD,
          bypassPaths: [good],
        }).ok,
      ).toBe(true);
    }
  });
});
