import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createLocalTestEnv,
  seedTestData,
  seedProject,
  type LocalTestEnv,
} from "../../local/test-env.js";
import { TEST_TEAM } from "../../test-helpers.js";
import { ensureProjectBindings, ensureQueue } from "./service.js";

vi.mock("./cloudflare.js", () => ({
  provisionCFResource: vi.fn(async (_env: unknown, cfType: string) => `new-${cfType}-id`),
  findExistingCFResource: vi.fn(async () => null),
  createQueue: vi.fn(async () => "new-queue-id"),
  getQueue: vi.fn(async () => null),
  setQueueConsumer: vi.fn(),
}));

let testEnv: LocalTestEnv;
beforeEach(() => {
  testEnv = createLocalTestEnv();
  seedTestData(testEnv);
  seedProject(testEnv, "app", { id: "proj-app", orgId: TEST_TEAM.id });
});
afterEach(() => testEnv.cleanup());

const count = (sql: string) => (testEnv.db.db.prepare(sql).get() as { n: number }).n;
// Queue rows, with whether the recorded name has Creek's provisioning shape.
const queued = () =>
  testEnv.db.db
    .prepare(
      `SELECT resourceType, cfResourceId, reason, status,
              (cfResourceName GLOB 'creek-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
               OR cfResourceName GLOB 'creek-q-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]') AS named
       FROM resource_cleanup_queue`,
    )
    .all();
/** Make every DB.batch fail after its statements run (a rolled-back transaction). */
function failBatches() {
  const env = testEnv.env as unknown as { DB: D1Database };
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = ((stmts: D1PreparedStatement[]) =>
    batch([
      ...stmts,
      env.DB.prepare("INSERT INTO no_such_table VALUES (1)"),
    ])) as typeof env.DB.batch;
}

describe("ensureProjectBindings — alias adoption", () => {
  function seedAlias() {
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
       VALUES ('res-alias', '${TEST_TEAM.id}', 'database', 'old-db', 'old-d1-id', 'd1', 'active', ${now}, ${now})`,
    );
    testEnv.db.db.exec(
      `INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt)
       VALUES ('proj-app', 'DB', 'res-alias', ${now})`,
    );
  }

  test("binds the resource already bound under the deprecated alias", async () => {
    seedAlias();

    const result = await ensureProjectBindings(testEnv.env, "proj-app", TEST_TEAM.id, [
      { type: "d1", bindingName: "DATABASE" },
    ]);

    expect(result.get("DATABASE")?.cfResourceId).toBe("old-d1-id");
  });

  test("never binds the alias's resource once it has been deleted under the deploy", async () => {
    seedAlias();
    // Between reading the alias and binding it, the alias is detached and the
    // resource deleted (its Cloudflare database queued for teardown).
    const env = testEnv.env as unknown as { DB: D1Database };
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (sql.includes("INSERT INTO project_resource_binding") && sql.includes("ON CONFLICT")) {
        testEnv.db.db.exec("DELETE FROM project_resource_binding WHERE resourceId = 'res-alias'");
        testEnv.db.db.exec("UPDATE resource SET status = 'deleted' WHERE id = 'res-alias'");
      }
      return prepare(sql);
    }) as typeof env.DB.prepare;

    const result = await ensureProjectBindings(testEnv.env, "proj-app", TEST_TEAM.id, [
      { type: "d1", bindingName: "DATABASE" },
    ]);

    // A fresh database instead of the one being torn down, and no binding
    // left to the old one under the alias name either.
    expect(result.get("DATABASE")?.cfResourceId).toBe("new-d1-id");
    expect(result.has("DB")).toBe(false);
    expect(
      count("SELECT COUNT(*) AS n FROM project_resource_binding WHERE resourceId = 'res-alias'"),
    ).toBe(0);
  });
});

describe("ensureProjectBindings — one resource under DATABASE and DB", () => {
  const resourcesOfKind = (kind: string) =>
    count(`SELECT COUNT(*) AS n FROM resource WHERE kind = '${kind}'`);
  const boundTo = (name: string) =>
    (
      testEnv.db.db
        .prepare(
          "SELECT resourceId FROM project_resource_binding WHERE projectId = 'proj-app' AND bindingName = ?",
        )
        .get(name) as { resourceId: string } | undefined
    )?.resourceId;

  test("a bundle declaring both creates one database and binds it under both names", async () => {
    // database = true declares DATABASE; a framework's Workers config names its D1 DB.
    const result = await ensureProjectBindings(testEnv.env, "proj-app", TEST_TEAM.id, [
      { type: "d1", bindingName: "DATABASE" },
      { type: "d1", bindingName: "DB" },
    ]);

    expect(resourcesOfKind("database")).toBe(1);
    expect(boundTo("DB")).toBe(boundTo("DATABASE"));
    expect(result.get("DB")?.cfResourceId).toBe(result.get("DATABASE")?.cfResourceId);
  });

  test("in either order", async () => {
    await ensureProjectBindings(testEnv.env, "proj-app", TEST_TEAM.id, [
      { type: "d1", bindingName: "DB" },
      { type: "d1", bindingName: "DATABASE" },
    ]);

    expect(resourcesOfKind("database")).toBe(1);
    expect(boundTo("DATABASE")).toBe(boundTo("DB"));
  });

  test("creates DATABASE before adopting it under DB, so a concurrent deploy cannot cross the pair", async () => {
    // Another deploy of the project binds DATABASE just before this one's
    // first new resource. Handling DB first would create a second database
    // under DB and adopt it under DATABASE; DATABASE first makes this
    // deploy's insert fail on the binding's key instead.
    const env = testEnv.env as unknown as { DB: D1Database };
    const batch = env.DB.batch.bind(env.DB);
    let raced = false;
    env.DB.batch = ((stmts: D1PreparedStatement[]) => {
      if (!raced) {
        raced = true;
        const now = Date.now();
        testEnv.db.db.exec(
          `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
           VALUES ('res-other', '${TEST_TEAM.id}', 'database', 'other', 'other-d1-id', 'd1', 'active', ${now}, ${now})`,
        );
        testEnv.db.db.exec(
          `INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt)
           VALUES ('proj-app', 'DATABASE', 'res-other', ${now})`,
        );
      }
      return batch(stmts);
    }) as typeof env.DB.batch;

    await expect(
      ensureProjectBindings(testEnv.env, "proj-app", TEST_TEAM.id, [
        { type: "d1", bindingName: "DB" },
        { type: "d1", bindingName: "DATABASE" },
      ]),
    ).rejects.toThrow();
    expect(boundTo("DATABASE")).toBe("res-other");
    expect(boundTo("DB")).toBeUndefined();
  });

  test("never overwrites a DB another deploy binds while this one adopts DATABASE's database", async () => {
    // A concurrent deploy that declares only DB creates its own database
    // under DB after this deploy read the bindings. Adopting DATABASE's
    // database under DB would leave that deploy's worker on an orphan.
    const env = testEnv.env as unknown as { DB: D1Database };
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (sql.includes("ON CONFLICT(projectId, bindingName)") && sql.includes("SELECT ?, ?, id")) {
        const now = Date.now();
        testEnv.db.db.exec(
          `INSERT OR IGNORE INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
           VALUES ('res-other', '${TEST_TEAM.id}', 'database', 'other', 'other-d1-id', 'd1', 'active', ${now}, ${now})`,
        );
        testEnv.db.db.exec(
          `INSERT OR IGNORE INTO project_resource_binding (projectId, bindingName, resourceId, createdAt)
           VALUES ('proj-app', 'DB', 'res-other', ${now})`,
        );
      }
      return prepare(sql);
    }) as typeof env.DB.prepare;

    await expect(
      ensureProjectBindings(testEnv.env, "proj-app", TEST_TEAM.id, [
        { type: "d1", bindingName: "DATABASE" },
        { type: "d1", bindingName: "DB" },
      ]),
    ).rejects.toThrow(/another deploy/);
    expect(boundTo("DB")).toBe("res-other");
  });

  test("binds a newly declared DB to the database already bound as DATABASE", async () => {
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
       VALUES ('res-main', '${TEST_TEAM.id}', 'database', 'main', 'main-d1-id', 'd1', 'active', ${now}, ${now})`,
    );
    testEnv.db.db.exec(
      `INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt)
       VALUES ('proj-app', 'DATABASE', 'res-main', ${now})`,
    );

    const result = await ensureProjectBindings(testEnv.env, "proj-app", TEST_TEAM.id, [
      { type: "d1", bindingName: "DATABASE" },
      { type: "d1", bindingName: "DB" },
    ]);

    expect(result.get("DB")?.cfResourceId).toBe("main-d1-id");
    expect(boundTo("DB")).toBe("res-main");
    expect(resourcesOfKind("database")).toBe(1);
  });

  test("does the same for CACHE and KV", async () => {
    await ensureProjectBindings(testEnv.env, "proj-app", TEST_TEAM.id, [
      { type: "kv", bindingName: "CACHE" },
      { type: "kv", bindingName: "KV" },
    ]);

    expect(resourcesOfKind("cache")).toBe(1);
    expect(boundTo("KV")).toBe(boundTo("CACHE"));
  });

  test("keeps a DB of another type apart from DATABASE", async () => {
    await ensureProjectBindings(testEnv.env, "proj-app", TEST_TEAM.id, [
      { type: "d1", bindingName: "DATABASE" },
      { type: "r2", bindingName: "DB" },
    ]);

    expect(resourcesOfKind("database")).toBe(1);
    expect(resourcesOfKind("storage")).toBe(1);
    expect(boundTo("DB")).not.toBe(boundTo("DATABASE"));
  });
});

describe("ensureProjectBindings — auto-created resource", () => {
  test("creates the resource and its binding", async () => {
    await ensureProjectBindings(testEnv.env, "proj-app", TEST_TEAM.id, [
      { type: "d1", bindingName: "DATABASE" },
    ]);

    expect(count("SELECT COUNT(*) AS n FROM resource WHERE cfResourceId = 'new-d1-id'")).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM project_resource_binding WHERE projectId = 'proj-app'"),
    ).toBe(1);
  });

  test("writes the resource and its binding in one transaction", async () => {
    // Never a moment where the new resource exists unbound: a resource delete
    // in that window would tear down the database this deploy is binding.
    // Shown by failing the transaction after its statements run: neither
    // row survives.
    failBatches();

    await expect(
      ensureProjectBindings(testEnv.env, "proj-app", TEST_TEAM.id, [
        { type: "d1", bindingName: "DATABASE" },
      ]),
    ).rejects.toThrow();

    expect(count("SELECT COUNT(*) AS n FROM resource WHERE cfResourceId = 'new-d1-id'")).toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM project_resource_binding WHERE projectId = 'proj-app'"),
    ).toBe(0);
    // The D1 was already provisioned; with its rows rolled back it is queued
    // for teardown under the name it was provisioned with, not orphaned.
    expect(queued()).toEqual([
      {
        resourceType: "d1",
        cfResourceId: "new-d1-id",
        reason: "provision_rolled_back",
        status: "pending",
        named: 1,
      },
    ]);
  });

  test("a queue whose rows roll back is queued for teardown too", async () => {
    failBatches();

    await expect(ensureQueue(testEnv.env, "proj-app", TEST_TEAM.id)).rejects.toThrow();

    expect(count("SELECT COUNT(*) AS n FROM resource WHERE cfResourceId = 'new-queue-id'")).toBe(0);
    expect(queued()).toEqual([
      {
        resourceType: "queue",
        cfResourceId: "new-queue-id",
        reason: "provision_rolled_back",
        status: "pending",
        named: 1,
      },
    ]);
  });
});
