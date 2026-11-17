import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createLocalTestEnv, seedTestData, type LocalTestEnv } from "../../local/test-env.js";
import { createTestApp, TEST_USER, TEST_TEAM } from "../../test-helpers.js";
import { setPrimary } from "./primary.js";

/**
 * Primary domain: the one custom domain per project that its default
 * hostname redirects to, and the project setting that turns the redirect on
 * or off. dispatch-worker reads both (canonical-host.test.ts).
 */

let testEnv: LocalTestEnv;
let app: ReturnType<typeof createTestApp>;
const originalFetch = globalThis.fetch;

const PROJECT_ID = "proj-1";
const OTHER_PROJECT_ID = "proj-2";

function setup(options?: Parameters<typeof createLocalTestEnv>[0]) {
  testEnv = createLocalTestEnv(options);
  seedTestData(testEnv);
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
  const now = Date.now();
  testEnv.db.db.exec(
    `INSERT INTO project (id, slug, organizationId, productionBranch, createdAt, updatedAt) VALUES
       ('${PROJECT_ID}', 'my-app', '${TEST_TEAM.id}', 'main', ${now}, ${now}),
       ('${OTHER_PROJECT_ID}', 'other-app', '${TEST_TEAM.id}', 'main', ${now}, ${now})`,
  );
}

beforeEach(() => {
  setup();
  // The edge registers every hostname and leaves it pending.
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("custom_hostnames")) {
      return new Response(
        JSON.stringify({
          success: true,
          result: { id: `cf-${Math.random()}`, status: "pending", ownership_verification: null },
        }),
      );
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

function seedDomain(
  id: string,
  opts: { projectId?: string; status?: string; isPrimary?: boolean; createdAt?: number } = {},
) {
  testEnv.db.db.exec(
    `INSERT INTO custom_domain (id, projectId, hostname, status, isPrimary, createdAt)
     VALUES ('${id}', '${opts.projectId ?? PROJECT_ID}', '${id}.example.com',
             '${opts.status ?? "active"}', ${opts.isPrimary ? 1 : 0}, ${opts.createdAt ?? 1000})`,
  );
}

const primaryOf = (projectId = PROJECT_ID) =>
  testEnv.db.db
    .prepare("SELECT id FROM custom_domain WHERE projectId = ? AND isPrimary = 1")
    .all(projectId)
    .map((r: any) => r.id);

const redirectOf = (projectId = PROJECT_ID) =>
  (
    testEnv.db.db
      .prepare("SELECT redirectToPrimaryDomain AS r FROM project WHERE id = ?")
      .get(projectId) as { r: number }
  ).r;

const auditActions = () =>
  testEnv.db.db
    .prepare("SELECT action FROM audit_log ORDER BY rowid")
    .all()
    .map((r: any) => r.action);

async function add(hostname: string, projectId = PROJECT_ID) {
  const res = await req("POST", `/projects/${projectId}/domains`, { hostname });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).domain as { id: string; isPrimary: number };
}

describe("adding a domain", () => {
  test("the project's first domain becomes its primary", async () => {
    const domain = await add("app.example.com");

    expect(domain.isPrimary).toBe(1);
    expect(primaryOf()).toEqual([domain.id]);
  });

  test("a second domain leaves the primary where it is", async () => {
    const first = await add("app.example.com");
    const second = await add("www.example.com");

    expect(second.isPrimary).toBe(0);
    expect(primaryOf()).toEqual([first.id]);
  });

  test("each project gets its own primary", async () => {
    const mine = await add("app.example.com");
    const theirs = await add("other.example.com", OTHER_PROJECT_ID);

    expect(primaryOf()).toEqual([mine.id]);
    expect(primaryOf(OTHER_PROJECT_ID)).toEqual([theirs.id]);
  });

  test("a new project redirects by default", () => {
    expect(redirectOf()).toBe(1);
  });

  test("the list shows which domain is primary", async () => {
    await add("app.example.com");
    await add("www.example.com");

    const res = await req("GET", `/projects/${PROJECT_ID}/domains`);
    const rows = (await res.json()) as Array<{ hostname: string; isPrimary: number }>;

    expect(Object.fromEntries(rows.map((r) => [r.hostname, r.isPrimary]))).toEqual({
      "app.example.com": 1,
      "www.example.com": 0,
    });
  });
});

describe("POST /projects/:id/domains/:domainId/primary", () => {
  test("moves the primary to the named domain", async () => {
    seedDomain("a", { isPrimary: true });
    seedDomain("b");

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/b/primary`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      changed: true,
      domain: { id: "b", hostname: "b.example.com", status: "active", isPrimary: 1 },
    });
    expect(primaryOf()).toEqual(["b"]);
    expect(auditActions()).toEqual(["domain.set_primary"]);
  });

  test("works when the project has no primary yet", async () => {
    seedDomain("a");

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/a/primary`);

    expect(res.status).toBe(200);
    expect(primaryOf()).toEqual(["a"]);
  });

  test("is a no-op on the domain that is already primary", async () => {
    seedDomain("a", { isPrimary: true });

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/a/primary`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as any).changed).toBe(false);
    expect(primaryOf()).toEqual(["a"]);
    expect(auditActions()).toEqual([]);
  });

  test("accepts a pending domain: it takes effect once active", async () => {
    seedDomain("a", { isPrimary: true });
    seedDomain("b", { status: "pending" });

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/b/primary`);

    expect(res.status).toBe(200);
    expect(primaryOf()).toEqual(["b"]);
  });

  test("leaves another project's primary alone", async () => {
    seedDomain("a", { isPrimary: true });
    seedDomain("b");
    seedDomain("x", { projectId: OTHER_PROJECT_ID, isPrimary: true });

    await req("POST", `/projects/${PROJECT_ID}/domains/b/primary`);

    expect(primaryOf(OTHER_PROJECT_ID)).toEqual(["x"]);
  });

  test("404s a domain of another project, changing nothing", async () => {
    seedDomain("a", { isPrimary: true });
    seedDomain("x", { projectId: OTHER_PROJECT_ID });

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/x/primary`);

    expect(res.status).toBe(404);
    expect(primaryOf()).toEqual(["a"]);
    expect(primaryOf(OTHER_PROJECT_ID)).toEqual([]);
  });

  test("404s an unknown project", async () => {
    const res = await req("POST", "/projects/nope/domains/a/primary");

    expect(res.status).toBe(404);
  });

  test("404s a project of another team", async () => {
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT INTO organization (id, name, slug, createdAt) VALUES ('team-x', 'X', 'x', ${now});
       INSERT INTO project (id, slug, organizationId, productionBranch, createdAt, updatedAt)
         VALUES ('proj-x', 'x-app', 'team-x', 'main', ${now}, ${now})`,
    );
    seedDomain("x", { projectId: "proj-x" });

    const res = await req("POST", "/projects/proj-x/domains/x/primary");

    expect(res.status).toBe(404);
    expect(primaryOf("proj-x")).toEqual([]);
  });
});

/**
 * The route reads the target, then moves the mark. A domain removed in
 * between must not cost the project the primary it had.
 */
describe("the target is removed while the primary is being moved", () => {
  test("setPrimary leaves the current primary and reports nothing moved", async () => {
    seedDomain("a", { isPrimary: true });

    const moved = await setPrimary(testEnv.env, PROJECT_ID, "gone");

    expect(moved).toBe(false);
    expect(primaryOf()).toEqual(["a"]);
  });

  test("setPrimary ignores a domain of another project", async () => {
    seedDomain("a", { isPrimary: true });
    seedDomain("x", { projectId: OTHER_PROJECT_ID });

    const moved = await setPrimary(testEnv.env, PROJECT_ID, "x");

    expect(moved).toBe(false);
    expect(primaryOf()).toEqual(["a"]);
    expect(primaryOf(OTHER_PROJECT_ID)).toEqual([]);
  });

  test("setPrimary reports a move", async () => {
    seedDomain("a", { isPrimary: true });
    seedDomain("b");

    expect(await setPrimary(testEnv.env, PROJECT_ID, "b")).toBe(true);
    expect(primaryOf()).toEqual(["b"]);
  });

  test("the route answers 404, keeps the primary and records nothing", async () => {
    seedDomain("a", { isPrimary: true });
    seedDomain("b");
    // The concurrent DELETE lands after the route has read `b`.
    const db = testEnv.env.DB;
    const batch = db.batch.bind(db);
    db.batch = (async (statements: Parameters<typeof batch>[0]) => {
      testEnv.db.db.exec("DELETE FROM custom_domain WHERE id = 'b'");
      return batch(statements);
    }) as typeof db.batch;

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/b/primary`);

    expect(res.status).toBe(404);
    expect(primaryOf()).toEqual(["a"]);
    expect(auditActions()).toEqual([]);
  });
});

describe("PATCH /projects/:id/domains", () => {
  test("turns the redirect off and back on", async () => {
    seedDomain("a", { isPrimary: true });

    const off = await req("PATCH", `/projects/${PROJECT_ID}/domains`, { redirectToPrimary: false });

    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({
      ok: true,
      redirectToPrimary: false,
      primary: { hostname: "a.example.com", status: "active" },
    });
    expect(redirectOf()).toBe(0);

    const on = await req("PATCH", `/projects/${PROJECT_ID}/domains`, { redirectToPrimary: true });

    expect(on.status).toBe(200);
    expect(redirectOf()).toBe(1);
    expect(auditActions()).toEqual(["domain.redirect_update", "domain.redirect_update"]);
  });

  test("reports no primary when the project has no domain", async () => {
    const res = await req("PATCH", `/projects/${PROJECT_ID}/domains`, { redirectToPrimary: true });

    expect(((await res.json()) as any).primary).toBeNull();
  });

  test("leaves other projects' setting alone", async () => {
    await req("PATCH", `/projects/${PROJECT_ID}/domains`, { redirectToPrimary: false });

    expect(redirectOf(OTHER_PROJECT_ID)).toBe(1);
  });

  test.each([
    ["a string", { redirectToPrimary: "false" }],
    ["a number", { redirectToPrimary: 0 }],
    ["missing", {}],
    ["not JSON", "nope"],
  ])("rejects a value that is %s", async (_label, body) => {
    const res = await req("PATCH", `/projects/${PROJECT_ID}/domains`, body);

    expect(res.status).toBe(400);
    expect(redirectOf()).toBe(1);
    expect(auditActions()).toEqual([]);
  });

  test("404s an unknown project", async () => {
    const res = await req("PATCH", "/projects/nope/domains", { redirectToPrimary: false });

    expect(res.status).toBe(404);
  });
});

describe("removing a domain", () => {
  test("removing the primary promotes the oldest active domain", async () => {
    seedDomain("a", { isPrimary: true, createdAt: 100 });
    seedDomain("pending", { status: "pending", createdAt: 200 });
    seedDomain("newer", { createdAt: 400 });
    seedDomain("older", { createdAt: 300 });

    const res = await req("DELETE", `/projects/${PROJECT_ID}/domains/a`);

    expect(res.status).toBe(200);
    expect(primaryOf()).toEqual(["older"]);
  });

  test("falls back to the oldest domain when none is active", async () => {
    seedDomain("a", { isPrimary: true, createdAt: 100 });
    seedDomain("second", { status: "pending", createdAt: 300 });
    seedDomain("first", { status: "pending", createdAt: 200 });

    await req("DELETE", `/projects/${PROJECT_ID}/domains/a`);

    expect(primaryOf()).toEqual(["first"]);
  });

  test("removing a non-primary domain leaves the primary where it is", async () => {
    seedDomain("a", { isPrimary: true, createdAt: 200 });
    seedDomain("b", { createdAt: 100 });

    await req("DELETE", `/projects/${PROJECT_ID}/domains/b`);

    expect(primaryOf()).toEqual(["a"]);
  });

  test("removing the last domain leaves no primary, and the next one added takes it", async () => {
    seedDomain("a", { isPrimary: true });

    await req("DELETE", `/projects/${PROJECT_ID}/domains/a`);
    expect(primaryOf()).toEqual([]);

    const next = await add("next.example.com");
    expect(primaryOf()).toEqual([next.id]);
  });

  test("never promotes a domain of another project", async () => {
    seedDomain("a", { isPrimary: true });
    seedDomain("x", { projectId: OTHER_PROJECT_ID });

    await req("DELETE", `/projects/${PROJECT_ID}/domains/a`);

    expect(primaryOf(OTHER_PROJECT_ID)).toEqual([]);
  });
});

/**
 * The Worker deploys on merge; migrations are applied by hand. Adding and
 * removing domains must keep working on a database before 0014, and the
 * primary-domain routes must say so rather than fail with a 500.
 */
describe("before migration 0014", () => {
  beforeEach(() => {
    testEnv.cleanup();
    setup({ migrationsUpTo: "0013_env_var_targets.sql" });
  });

  test("a domain can still be added and removed", async () => {
    const added = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "app.example.com",
    });
    expect(added.status).toBe(201);
    const { domain } = (await added.json()) as any;
    expect(domain.hostname).toBe("app.example.com");

    const removed = await req("DELETE", `/projects/${PROJECT_ID}/domains/${domain.id}`);
    expect(removed.status).toBe(200);
    expect(testEnv.db.db.prepare("SELECT COUNT(*) AS n FROM custom_domain").get()).toEqual({
      n: 0,
    });
  });

  test("setting a primary reports unavailable", async () => {
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('a', '${PROJECT_ID}', 'a.example.com', 'active', 1000)`,
    );

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/a/primary`);

    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toBe("unavailable");
  });

  test("changing the redirect reports unavailable", async () => {
    const res = await req("PATCH", `/projects/${PROJECT_ID}/domains`, { redirectToPrimary: false });

    expect(res.status).toBe(503);
    expect(auditActions()).toEqual([]);
  });
});
