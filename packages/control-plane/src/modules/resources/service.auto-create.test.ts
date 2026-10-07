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

    // A fresh database instead of the one being torn down.
    expect(result.get("DATABASE")?.cfResourceId).toBe("new-d1-id");
    expect(
      count("SELECT COUNT(*) AS n FROM project_resource_binding WHERE resourceId = 'res-alias'"),
    ).toBe(0);
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
