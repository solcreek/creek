import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createLocalTestEnv,
  seedTestData,
  seedProject,
  type LocalTestEnv,
} from "../../local/test-env.js";
import { createTestApp, TEST_USER, TEST_TEAM } from "../../test-helpers.js";
import { processResourceCleanupQueue } from "./cleanup-queue.js";
import { findExistingCFResource, provisionCFResource } from "./cloudflare.js";

// Provisioning is the only way a resource gets a Cloudflare resource; stand
// it in so creating one doesn't call Cloudflare.
vi.mock("./cloudflare.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cloudflare.js")>()),
  findExistingCFResource: vi.fn(async () => null),
  provisionCFResource: vi.fn(async (_env: unknown, cfType: string, name: string) =>
    cfType === "r2" ? name : `${cfType}-for-${name}`,
  ),
}));

let testEnv: LocalTestEnv;
let app: ReturnType<typeof createTestApp>;
const teamId = TEST_TEAM.id;

beforeEach(() => {
  testEnv = createLocalTestEnv();
  seedTestData(testEnv);
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  testEnv.cleanup();
  globalThis.fetch = originalFetch;
});

function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, testEnv.env);
}

describe("resources input validation", () => {
  test("POST /resources rejects unknown kind", async () => {
    const res = await req("POST", "/resources", { kind: "wat", name: "x" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation");
  });

  test("POST /resources rejects uppercase name", async () => {
    const res = await req("POST", "/resources", { kind: "database", name: "BadName" });
    expect(res.status).toBe(400);
  });

  test("POST /resources rejects name with space", async () => {
    const res = await req("POST", "/resources", { kind: "database", name: "my db" });
    expect(res.status).toBe(400);
  });

  test("POST /resources accepts valid database kind + hyphen name and provisions its D1", async () => {
    const res = await req("POST", "/resources", { kind: "database", name: "my-db" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      teamId: string;
      kind: string;
      name: string;
      cfResourceId: string;
      status: string;
    };
    expect(body.kind).toBe("database");
    expect(body.name).toBe("my-db");
    // Provisioned under Creek's name for it: 26 hex digits of the id, so it
    // can't collide with another team's resource.
    expect(body.cfResourceId).toBe(`d1-for-creek-${body.id.replace(/-/g, "").slice(0, 26)}`);
    expect(body.status).toBe("active");
    expect(body.teamId).toBe(teamId);
    // UUIDs are 36-char
    expect(body.id).toHaveLength(36);

    // Verify the resource is actually in the DB
    const row = testEnv.db.db.prepare("SELECT * FROM resource WHERE name = ?").get("my-db") as any;
    expect(row).toBeDefined();
    expect(row.kind).toBe("database");
  });

  test("POST /resources accepts storage / cache / ai kinds", async () => {
    for (const kind of ["storage", "cache", "ai"]) {
      const res = await req("POST", "/resources", { kind, name: `r-${kind}` });
      expect(res.status).toBe(201);
    }
  });

  test("POST /resources answers 400 to a body that isn't a JSON object", async () => {
    for (const body of ["x", 1, false, null, []]) {
      const res = await app.request(
        "/resources",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        testEnv.env,
      );
      expect(res.status).toBe(400);
    }
  });

  test("POST /resources refuses a caller-supplied Cloudflare resource", async () => {
    // Earlier tests provision; count only what this one does.
    vi.clearAllMocks();
    // Pointing a new resource at an existing Cloudflare ID would hand this
    // team another tenant's (or the control plane's own) database.
    for (const extra of [
      { cfResourceId: "b9fe9847-fbed-48a9-8c4d-a895289be631" },
      { cfResourceType: "d1" },
      { cfResourceId: null },
    ]) {
      const res = await req("POST", "/resources", { kind: "database", name: "adopt", ...extra });
      expect(res.status).toBe(400);
    }

    expect(testEnv.db.db.prepare("SELECT COUNT(*) AS n FROM resource").get()).toEqual({ n: 0 });
    expect(provisionCFResource).not.toHaveBeenCalled();
    expect(findExistingCFResource).not.toHaveBeenCalled();
  });

  test("POST bindings rejects lowercase binding name", async () => {
    seedProject(testEnv, "p1");
    const res = await req("POST", "/projects/p1/bindings", {
      resourceId: crypto.randomUUID(),
      bindingName: "lowercase",
    });
    // validation error comes before the resource lookup
    expect(res.status).toBe(400);
  });

  test("POST bindings rejects binding name starting with digit", async () => {
    seedProject(testEnv, "p1");
    const res = await req("POST", "/projects/p1/bindings", {
      resourceId: crypto.randomUUID(),
      bindingName: "1BAD",
    });
    expect(res.status).toBe(400);
  });

  test("POST bindings returns 404 when project not in team", async () => {
    // Don't seed a project named "nope" — it shouldn't exist
    const res = await req("POST", "/projects/nope/bindings", {
      resourceId: crypto.randomUUID(),
      bindingName: "DB",
    });
    expect(res.status).toBe(404);
  });

  test("GET /resources returns empty when team has none", async () => {
    const res = await req("GET", "/resources");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resources: unknown[] };
    expect(body.resources).toEqual([]);
  });

  test("DELETE /resources/:id returns 409 when bindings exist", async () => {
    // Create a resource and a binding to it
    const resourceId = "res-abc";
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt) VALUES ('${resourceId}', '${teamId}', 'database', 'test-db', 'd1-uuid', 'd1', 'active', ${now}, ${now})`,
    );
    const projId = seedProject(testEnv, "bound-proj");
    testEnv.db.db.exec(
      `INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt) VALUES ('${projId}', 'DB', '${resourceId}', ${now})`,
    );

    const res = await req("DELETE", `/resources/${resourceId}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("has_bindings");
    expect(cleanupRows()).toEqual([]);
  });
});

function cleanupRows() {
  return testEnv.db.db
    .prepare(
      "SELECT resourceType, cfResourceId, cfResourceName, status, reason, createdAt FROM resource_cleanup_queue ORDER BY id",
    )
    .all() as Array<{
    resourceType: string;
    cfResourceId: string;
    cfResourceName: string;
    status: string;
    reason: string;
    createdAt: number;
  }>;
}

function seedResource(
  id: string,
  opts: { kind: string; cfResourceId: string | null; cfResourceType: string | null; team?: string },
) {
  const now = Date.now();
  const q = (v: string | null) => (v === null ? "NULL" : `'${v}'`);
  testEnv.db.db.exec(
    `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
     VALUES ('${id}', '${opts.team ?? teamId}', '${opts.kind}', '${id}-name', ${q(opts.cfResourceId)}, ${q(opts.cfResourceType)}, 'active', ${now}, ${now})`,
  );
}

describe("DELETE /resources/:id tears down the Cloudflare resource", () => {
  test("queues the D1 for the scheduled cleanup and marks the row deleted", async () => {
    seedResource("res-d1", { kind: "database", cfResourceId: "d1-uuid", cfResourceType: "d1" });
    const before = Math.floor(Date.now() / 1000);

    const res = await req("DELETE", "/resources/res-d1");

    expect(res.status).toBe(200);
    const row = testEnv.db.db.prepare("SELECT status FROM resource WHERE id = 'res-d1'").get() as {
      status: string;
    };
    expect(row.status).toBe("deleted");
    const queued = cleanupRows();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      resourceType: "d1",
      cfResourceId: "d1-uuid",
      // The name Creek gives what it provisions, checked before deleting.
      cfResourceName: "creek-resd1",
      status: "pending",
      reason: "resource_deleted",
    });
    // Seconds, as the column's drizzle `timestamp` mode stores them.
    expect(queued[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(queued[0].createdAt).toBeLessThan(before + 60);
  });

  test("an older row without cfResourceType is queued by its kind (R2 by bucket name)", async () => {
    seedResource("res-r2", {
      kind: "storage",
      cfResourceId: "creek-bucket-1",
      cfResourceType: null,
    });

    expect((await req("DELETE", "/resources/res-r2")).status).toBe(200);

    expect(cleanupRows()).toMatchObject([
      { resourceType: "r2", cfResourceId: "creek-bucket-1", cfResourceName: "creek-resr2" },
    ]);
  });

  test("the teardown expects the exact name the resource was provisioned under", async () => {
    // The delete route computes the name in SQL; provisioning computes it in
    // JS. If they drift, the cleanup refuses to delete anything.
    const created = await req("POST", "/resources", { kind: "database", name: "roundtrip" });
    const { id, cfResourceId } = (await created.json()) as { id: string; cfResourceId: string };
    expect((await req("DELETE", `/resources/${id}`)).status).toBe(200);

    const provisionedAs = cfResourceId.replace(/^d1-for-/, "");
    expect(cleanupRows()[0].cfResourceName).toBe(provisionedAs);
  });

  test("deleting twice queues the teardown once", async () => {
    seedResource("res-kv", { kind: "cache", cfResourceId: "kv-1", cfResourceType: "kv" });

    expect((await req("DELETE", "/resources/res-kv")).status).toBe(200);
    expect((await req("DELETE", "/resources/res-kv")).status).toBe(404);

    expect(cleanupRows()).toHaveLength(1);
  });

  test("another team's resource is neither deleted nor queued", async () => {
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES ('team-other', 'Other', 'other', ${Date.now()})`,
    );
    seedResource("res-other", {
      kind: "database",
      cfResourceId: "d1-other",
      cfResourceType: "d1",
      team: "team-other",
    });

    expect((await req("DELETE", "/resources/res-other")).status).toBe(404);

    expect(cleanupRows()).toEqual([]);
    const row = testEnv.db.db
      .prepare("SELECT status FROM resource WHERE id = 'res-other'")
      .get() as {
      status: string;
    };
    expect(row.status).toBe("active");
  });

  test("nothing is queued while another live row uses the same Cloudflare resource", async () => {
    seedResource("res-one", { kind: "database", cfResourceId: "shared-d1", cfResourceType: "d1" });
    seedResource("res-two", { kind: "database", cfResourceId: "shared-d1", cfResourceType: "d1" });

    expect((await req("DELETE", "/resources/res-one")).status).toBe(200);

    expect(cleanupRows()).toEqual([]);
  });

  test("a row adopted before IDs were refused never deletes the resource it points at", async () => {
    // Rows created when POST /resources still accepted a cfResourceId may
    // point at a database Creek provisioned for someone else.
    seedResource("res-adopted", {
      kind: "database",
      cfResourceId: "victim-d1-uuid",
      cfResourceType: "d1",
    });
    const id = "res-adopted";
    expect((await req("DELETE", `/resources/${id}`)).status).toBe(200);

    // Queued under the adopting row's own expected name, not the victim's.
    const [queued] = cleanupRows();
    expect(queued.cfResourceName).toBe("creek-resadopted");

    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      // Cloudflare reports the victim database under its own creek- name.
      return Response.json({ success: true, result: { name: "creek-victim00" }, errors: [] });
    }) as typeof fetch;
    testEnv.env.CLOUDFLARE_ACCOUNT_ID = "acc";
    await processResourceCleanupQueue(testEnv.env);

    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    expect(cleanupRows()[0].status).toBe("failed");
  });

  test("a project attaching the resource during the delete wins: nothing is torn down", async () => {
    seedResource("res-race", { kind: "database", cfResourceId: "d1-race", cfResourceType: "d1" });
    const projId = seedProject(testEnv, "racer");
    // The attach lands after the delete's binding check, before its batch.
    const env = testEnv.env as unknown as { DB: D1Database };
    const batch = env.DB.batch.bind(env.DB);
    env.DB.batch = (async (stmts: D1PreparedStatement[]) => {
      testEnv.db.db.exec(
        `INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt)
         VALUES ('${projId}', 'DATABASE', 'res-race', ${Date.now()})`,
      );
      return batch(stmts);
    }) as typeof env.DB.batch;

    const res = await req("DELETE", "/resources/res-race");

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("has_bindings");
    expect(cleanupRows()).toEqual([]);
    const row = testEnv.db.db
      .prepare("SELECT status FROM resource WHERE id = 'res-race'")
      .get() as {
      status: string;
    };
    expect(row.status).toBe("active");
  });

  // A project attaches the resource just before the delete's batch (blocking
  // it) and detaches it again just after, before the delete looks at why it
  // changed nothing: the resource is live and unbound, not gone.
  function attachAroundBatches(resourceId: string, projId: string, times: number) {
    const env = testEnv.env as unknown as { DB: D1Database };
    const batch = env.DB.batch.bind(env.DB);
    let left = times;
    env.DB.batch = (async (stmts: D1PreparedStatement[]) => {
      if (left-- <= 0) return batch(stmts);
      testEnv.db.db.exec(
        `INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt)
         VALUES ('${projId}', 'DATABASE', '${resourceId}', ${Date.now()})`,
      );
      const out = await batch(stmts);
      testEnv.db.db.exec(`DELETE FROM project_resource_binding WHERE resourceId = '${resourceId}'`);
      return out;
    }) as typeof env.DB.batch;
  }
  const statusOf = (id: string) =>
    (
      testEnv.db.db.prepare("SELECT status FROM resource WHERE id = ?").get(id) as {
        status: string;
      }
    ).status;

  test("an attach-then-detach during the delete never reads as 404: it deletes on a retry", async () => {
    seedResource("res-flap", { kind: "database", cfResourceId: "d1-flap", cfResourceType: "d1" });
    attachAroundBatches("res-flap", seedProject(testEnv, "flapper"), 1);

    const res = await req("DELETE", "/resources/res-flap");

    expect(res.status).toBe(200);
    expect(statusOf("res-flap")).toBe("deleted");
    expect(cleanupRows()).toHaveLength(1);
  });

  test("a resource that keeps changing under the delete is a retryable 409, never a 404", async () => {
    seedResource("res-busy", { kind: "database", cfResourceId: "d1-busy", cfResourceType: "d1" });
    attachAroundBatches("res-busy", seedProject(testEnv, "busy"), 2);

    const res = await req("DELETE", "/resources/res-busy");

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", retryable: true });
    expect(statusOf("res-busy")).toBe("active");
    expect(cleanupRows()).toEqual([]);
  });

  test("a deleted resource can't be attached, so it can't be torn down under a project", async () => {
    seedResource("res-gone", { kind: "database", cfResourceId: "d1-gone", cfResourceType: "d1" });
    seedProject(testEnv, "late-app");
    expect((await req("DELETE", "/resources/res-gone")).status).toBe(200);

    const res = await req("POST", "/projects/late-app/bindings", {
      resourceId: "res-gone",
      bindingName: "DATABASE",
    });

    expect(res.status).toBe(404);
    expect(
      testEnv.db.db
        .prepare("SELECT COUNT(*) AS n FROM project_resource_binding WHERE resourceId = 'res-gone'")
        .get(),
    ).toEqual({ n: 0 });
  });

  test("a resource that was never provisioned has nothing to tear down", async () => {
    seedResource("res-none", { kind: "database", cfResourceId: null, cfResourceType: null });

    expect((await req("DELETE", "/resources/res-none")).status).toBe(200);

    expect(cleanupRows()).toEqual([]);
  });
});

describe("POST /resources never leaves a Cloudflare resource orphaned on a name clash", () => {
  test("a taken name is refused before anything is provisioned", async () => {
    expect((await req("POST", "/resources", { kind: "database", name: "taken" })).status).toBe(201);
    vi.clearAllMocks();

    const res = await req("POST", "/resources", { kind: "database", name: "taken" });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("conflict");
    expect(findExistingCFResource).not.toHaveBeenCalled();
    expect(provisionCFResource).not.toHaveBeenCalled();
    expect(cleanupRows()).toEqual([]);
  });

  test("a deleted resource's name is still taken, and refused before provisioning", async () => {
    seedResource("res-old", { kind: "cache", cfResourceId: "kv-old", cfResourceType: "kv" });
    expect((await req("DELETE", "/resources/res-old")).status).toBe(200);
    vi.clearAllMocks();

    const res = await req("POST", "/resources", { kind: "cache", name: "res-old-name" });

    expect(res.status).toBe(409);
    expect(provisionCFResource).not.toHaveBeenCalled();
  });

  test("losing the name to a concurrent create queues what was provisioned for teardown", async () => {
    // The other create inserts its row after this one's name check, while
    // this one is provisioning.
    vi.mocked(provisionCFResource).mockImplementationOnce(async (_env, cfType, name) => {
      const now = Date.now();
      testEnv.db.db.exec(
        `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
         VALUES ('res-winner', '${teamId}', 'database', 'contested', 'd1-winner', 'd1', 'active', ${now}, ${now})`,
      );
      return `${cfType}-for-${name}`;
    });

    const res = await req("POST", "/resources", { kind: "database", name: "contested" });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("conflict");
    const [provisionedAs] = vi.mocked(provisionCFResource).mock.calls.at(-1)!.slice(2) as [string];
    expect(provisionedAs).toMatch(/^creek-[0-9a-f]{26}$/);
    expect(cleanupRows()).toMatchObject([
      {
        resourceType: "d1",
        cfResourceId: `d1-for-${provisionedAs}`,
        // The cleanup deletes only a resource still carrying this name.
        cfResourceName: provisionedAs,
        status: "pending",
        reason: "provision_rolled_back",
      },
    ]);
    // The winner's row is untouched and nothing else was written.
    expect(testEnv.db.db.prepare("SELECT id FROM resource WHERE name = 'contested'").all()).toEqual(
      [{ id: "res-winner" }],
    );
  });
});

describe("re-running a resource request says what already holds the name", () => {
  type Conflict = {
    error: string;
    message: string;
    existing?: Record<string, unknown>;
    missing?: string;
  };

  test("a second create's 409 carries the existing resource", async () => {
    const first = (await (
      await req("POST", "/resources", { kind: "database", name: "twice" })
    ).json()) as { id: string; cfResourceId: string };

    const res = await req("POST", "/resources", { kind: "database", name: "twice" });

    expect(res.status).toBe(409);
    const body = (await res.json()) as Conflict;
    expect(body.error).toBe("conflict");
    // Only what a caller needs to decide; the route needs resource:write
    // alone, so nothing resource:read guards (Cloudflare ids, team, times).
    expect(body.existing).toEqual({
      id: first.id,
      kind: "database",
      name: "twice",
      status: "active",
    });
  });

  test("a create clashing with another kind names that kind", async () => {
    await req("POST", "/resources", { kind: "cache", name: "shared-name" });

    const body = (await (
      await req("POST", "/resources", { kind: "database", name: "shared-name" })
    ).json()) as Conflict;

    expect(body.existing).toMatchObject({ kind: "cache", status: "active" });
    expect(body.message).toContain("cache");
  });

  test("a create reusing a deleted resource's name says the name is reserved", async () => {
    seedResource("res-tomb", { kind: "database", cfResourceId: "d1-tomb", cfResourceType: "d1" });
    await req("DELETE", "/resources/res-tomb");

    const body = (await (
      await req("POST", "/resources", { kind: "database", name: "res-tomb-name" })
    ).json()) as Conflict;

    expect(body.existing).toMatchObject({ id: "res-tomb", status: "deleted" });
    expect(body.message).toContain("deleted");
  });

  test("GET /resources lists deleted resources only when asked", async () => {
    seedResource("res-live", { kind: "database", cfResourceId: null, cfResourceType: null });
    seedResource("res-dead", { kind: "database", cfResourceId: null, cfResourceType: null });
    await req("DELETE", "/resources/res-dead");

    const ids = async (path: string) =>
      ((await (await req("GET", path)).json()) as { resources: Array<{ id: string }> }).resources
        .map((r) => r.id)
        .sort();

    expect(await ids("/resources")).toEqual(["res-live"]);
    expect(await ids("/resources?include=deleted")).toEqual(["res-dead", "res-live"]);

    // Deleted rows carry the same columns as the normal list, nothing more.
    const rows = (
      (await (await req("GET", "/resources?include=deleted")).json()) as {
        resources: Array<Record<string, unknown>>;
      }
    ).resources;
    const live = rows.find((r) => r.id === "res-live")!;
    const dead = rows.find((r) => r.id === "res-dead")!;
    expect(Object.keys(dead).sort()).toEqual(Object.keys(live).sort());
  });

  test("a second attach's 409 carries the binding, pointing at the same resource", async () => {
    seedResource("res-db", { kind: "database", cfResourceId: null, cfResourceType: null });
    seedProject(testEnv, "app");
    const attach = { resourceId: "res-db", bindingName: "DB" };
    expect((await req("POST", "/projects/app/bindings", attach)).status).toBe(201);

    const res = await req("POST", "/projects/app/bindings", attach);

    expect(res.status).toBe(409);
    const body = (await res.json()) as Conflict;
    // The binding on the caller's own project plus the resource's kind and
    // name; nothing resource:read guards (Cloudflare ids, team).
    expect(body.existing).toEqual({
      projectId: "proj-app",
      bindingName: "DB",
      resourceId: "res-db",
      createdAt: expect.any(Number),
      kind: "database",
      name: "res-db-name",
    });
    expect(body.message).toContain("already attached");
  });

  test("an attach clashing with another resource's binding names that resource", async () => {
    seedResource("res-a", { kind: "database", cfResourceId: null, cfResourceType: null });
    seedResource("res-b", { kind: "database", cfResourceId: null, cfResourceType: null });
    seedProject(testEnv, "app");
    await req("POST", "/projects/app/bindings", { resourceId: "res-a", bindingName: "DB" });

    const body = (await (
      await req("POST", "/projects/app/bindings", { resourceId: "res-b", bindingName: "DB" })
    ).json()) as Conflict;

    expect(body.existing).toMatchObject({ resourceId: "res-a", name: "res-a-name" });
  });

  test("a second detach says the binding is missing, not the project", async () => {
    seedResource("res-db", { kind: "database", cfResourceId: null, cfResourceType: null });
    seedProject(testEnv, "app");
    await req("POST", "/projects/app/bindings", { resourceId: "res-db", bindingName: "DB" });
    expect((await req("DELETE", "/projects/app/bindings/DB")).status).toBe(200);

    const again = await req("DELETE", "/projects/app/bindings/DB");
    expect(again.status).toBe(404);
    const body = (await again.json()) as Conflict;
    expect(body.missing).toBe("binding");
    expect(body.message).toBe("Project 'app' has no binding named 'DB'; nothing was detached");

    const noProject = (await (
      await req("DELETE", "/projects/nope/bindings/DB")
    ).json()) as Conflict;
    expect(noProject.missing).toBe("project");
  });
});

describe("POST /resources/:id/query", () => {
  const resourceId = "res-db-1";

  function seedDatabase(
    overrides?: Partial<{
      kind: string;
      cfResourceId: string | null;
      cfResourceType: string | null;
      status: string;
    }>,
  ) {
    const defaults = {
      kind: "database",
      cfResourceId: "d1-uuid-abc",
      cfResourceType: "d1",
      status: "active",
      ...overrides,
    };
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR REPLACE INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt) VALUES ('${resourceId}', '${teamId}', '${defaults.kind}', 'test-db', ${defaults.cfResourceId ? `'${defaults.cfResourceId}'` : "NULL"}, ${defaults.cfResourceType ? `'${defaults.cfResourceType}'` : "NULL"}, '${defaults.status}', ${now}, ${now})`,
    );
  }

  test("returns 404 for unknown resource", async () => {
    const res = await req("POST", `/resources/${resourceId}/query`, { sql: "SELECT 1" });
    expect(res.status).toBe(404);
  });

  test("rejects non-database resource", async () => {
    seedDatabase({ kind: "storage", cfResourceType: "r2" });
    const res = await req("POST", `/resources/${resourceId}/query`, { sql: "SELECT 1" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_kind");
  });

  test("rejects unprovisioned database", async () => {
    seedDatabase({ cfResourceId: null });
    const res = await req("POST", `/resources/${resourceId}/query`, { sql: "SELECT 1" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_provisioned");
  });

  test("rejects inactive resource", async () => {
    seedDatabase({ status: "deleted" });
    const res = await req("POST", `/resources/${resourceId}/query`, { sql: "SELECT 1" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_active");
  });

  test("rejects missing sql field", async () => {
    seedDatabase();
    const res = await req("POST", `/resources/${resourceId}/query`, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation");
  });

  test("rejects sql exceeding 100KB", async () => {
    seedDatabase();
    const res = await req("POST", `/resources/${resourceId}/query`, { sql: "X".repeat(100_001) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("100KB");
  });

  test("rejects non-array params", async () => {
    seedDatabase();
    const res = await req("POST", `/resources/${resourceId}/query`, {
      sql: "SELECT 1",
      params: "bad",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation");
  });

  test("proxies query and returns structured result", async () => {
    seedDatabase();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              results: [{ id: 1, name: "hello" }],
              meta: { changes: 0, duration: 1.5, rows_read: 1, rows_written: 0 },
            },
          ],
        }),
      ),
    );

    const res = await req("POST", `/resources/${resourceId}/query`, { sql: "SELECT * FROM test" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.columns).toEqual(["id", "name"]);
    expect(body.rows).toEqual([{ id: 1, name: "hello" }]);
    expect(body.meta.duration).toBe(1.5);

    // Verify the CF D1 API was called correctly
    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toContain("/d1/database/d1-uuid-abc/query");
    const reqBody = JSON.parse(call[1].body);
    expect(reqBody.sql).toBe("SELECT * FROM test");
  });

  test("returns error when CF D1 query fails", async () => {
    seedDatabase();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ message: "SQLITE_ERROR: no such table: foo" }],
        }),
      ),
    );

    const res = await req("POST", `/resources/${resourceId}/query`, { sql: "SELECT * FROM foo" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("query_failed");
    expect(body.message).toContain("no such table");
  });
});
