import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createMockD1,
  createTestEnv,
  createTestApp,
  seedMemberRole,
  TEST_USER,
  TEST_TEAM,
  type MockD1,
} from "../../test-helpers.js";

let db: MockD1;
let env: ReturnType<typeof createTestEnv>;
let app: ReturnType<typeof createTestApp>;
const teamId = TEST_TEAM.id;

beforeEach(() => {
  db = createMockD1();
  env = createTestEnv(db);
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
  seedMemberRole(db);
});

function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, env);
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

  test("POST /resources accepts valid database kind + hyphen name (pre-provisioned)", async () => {
    // Pass cfResourceId to skip auto-provision (no CF API in tests)
    const res = await req("POST", "/resources", { kind: "database", name: "my-db", cfResourceId: "test-d1-uuid" });
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
    expect(body.cfResourceId).toBe("test-d1-uuid");
    expect(body.status).toBe("active");
    expect(body.teamId).toBe(teamId);
    // UUIDs are 36-char
    expect(body.id).toHaveLength(36);
  });

  test("POST /resources accepts storage / cache / ai kinds", async () => {
    for (const kind of ["storage", "cache", "ai"]) {
      // Pass cfResourceId for provisionable kinds; ai has no CF resource
      const extra = kind === "ai" ? {} : { cfResourceId: `test-${kind}-id` };
      const res = await req("POST", "/resources", { kind, name: `r-${kind}`, ...extra });
      expect(res.status).toBe(201);
    }
  });

  test("POST bindings rejects lowercase binding name", async () => {
    db.seedFirst("FROM project WHERE slug = ?", ["p1", teamId], { id: "proj-1" });
    const res = await req("POST", "/projects/p1/bindings", {
      resourceId: crypto.randomUUID(),
      bindingName: "lowercase",
    });
    // validation error comes before the resource lookup
    expect(res.status).toBe(400);
  });

  test("POST bindings rejects binding name starting with digit", async () => {
    db.seedFirst("FROM project WHERE slug = ?", ["p1", teamId], { id: "proj-1" });
    const res = await req("POST", "/projects/p1/bindings", {
      resourceId: crypto.randomUUID(),
      bindingName: "1BAD",
    });
    expect(res.status).toBe(400);
  });

  test("POST bindings returns 404 when project not in team", async () => {
    db.seedFirst("FROM project WHERE slug = ?", ["nope", teamId], null);
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
    const id = "res-abc";
    db.seedFirst("FROM project_resource_binding WHERE resourceId = ?", [id], { n: 1 });
    const res = await req("DELETE", `/resources/${id}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("has_bindings");
  });
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("POST /resources/:id/query", () => {
  const resourceId = "res-db-1";

  function seedDatabase(overrides?: Partial<{ kind: string; cfResourceId: string | null; cfResourceType: string | null; status: string }>) {
    db.seedFirst("SELECT kind, cfResourceId, cfResourceType, status FROM resource WHERE", [resourceId, TEST_TEAM.id], {
      kind: "database",
      cfResourceId: "d1-uuid-abc",
      cfResourceType: "d1",
      status: "active",
      ...overrides,
    });
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
    const res = await req("POST", `/resources/${resourceId}/query`, { sql: "SELECT 1", params: "bad" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation");
  });

  test("proxies query and returns structured result", async () => {
    seedDatabase();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        result: [{
          results: [{ id: 1, name: "hello" }],
          meta: { changes: 0, duration: 1.5, rows_read: 1, rows_written: 0 },
        }],
      })),
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
      new Response(JSON.stringify({
        success: false,
        errors: [{ message: "SQLITE_ERROR: no such table: foo" }],
      })),
    );

    const res = await req("POST", `/resources/${resourceId}/query`, { sql: "SELECT * FROM foo" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("query_failed");
    expect(body.message).toContain("no such table");
  });
});
