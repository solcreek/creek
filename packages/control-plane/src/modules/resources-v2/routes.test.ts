import { describe, test, expect, beforeEach } from "vitest";
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

describe("resources-v2 input validation", () => {
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

  test("POST /resources accepts valid database kind + hyphen name", async () => {
    const res = await req("POST", "/resources", { kind: "database", name: "my-db" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      teamId: string;
      kind: string;
      name: string;
      status: string;
    };
    expect(body.kind).toBe("database");
    expect(body.name).toBe("my-db");
    expect(body.status).toBe("active");
    expect(body.teamId).toBe(teamId);
    // UUIDs are 36-char
    expect(body.id).toHaveLength(36);
  });

  test("POST /resources accepts storage / cache / ai kinds", async () => {
    for (const kind of ["storage", "cache", "ai"]) {
      const res = await req("POST", "/resources", { kind, name: `r-${kind}` });
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
