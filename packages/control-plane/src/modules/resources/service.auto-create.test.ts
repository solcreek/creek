import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createLocalTestEnv,
  seedTestData,
  seedProject,
  type LocalTestEnv,
} from "../../local/test-env.js";
import { TEST_TEAM } from "../../test-helpers.js";
import { ensureProjectBindings } from "./service.js";

vi.mock("./cloudflare.js", () => ({
  provisionCFResource: vi.fn(async (_env: unknown, cfType: string) => `new-${cfType}-id`),
  findExistingCFResource: vi.fn(async () => null),
  createQueue: vi.fn(),
  getQueue: vi.fn(),
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
    const env = testEnv.env as unknown as { DB: D1Database };
    const batch = env.DB.batch.bind(env.DB);
    env.DB.batch = ((stmts: D1PreparedStatement[]) =>
      batch([
        ...stmts,
        env.DB.prepare("INSERT INTO no_such_table VALUES (1)"),
      ])) as typeof env.DB.batch;

    await expect(
      ensureProjectBindings(testEnv.env, "proj-app", TEST_TEAM.id, [
        { type: "d1", bindingName: "DATABASE" },
      ]),
    ).rejects.toThrow();

    expect(count("SELECT COUNT(*) AS n FROM resource WHERE cfResourceId = 'new-d1-id'")).toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM project_resource_binding WHERE projectId = 'proj-app'"),
    ).toBe(0);
  });
});
