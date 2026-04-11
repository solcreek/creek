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
let teamId: string;

beforeEach(() => {
  db = createMockD1();
  env = createTestEnv(db);
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
  teamId = TEST_TEAM.id;
  seedMemberRole(db); // owner role for RBAC guards
});

function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, env);
}

// --- Projects CRUD ---

describe("POST /projects", () => {
  test("creates project with valid slug", async () => {
    db.seedFirst("SELECT id FROM project WHERE slug", ["my-app", teamId], null);

    const res = await req("POST", "/projects", { slug: "my-app" });
    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.project).toBeDefined();
  });

  test("rejects invalid slug (uppercase)", async () => {
    const res = await req("POST", "/projects", { slug: "My-App" });
    expect(res.status).toBe(400);
  });

  test("rejects slug containing -git-", async () => {
    const res = await req("POST", "/projects", { slug: "my-git-app" });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.message).toContain("-git-");
  });

  test("rejects duplicate slug in same team (strict mode, default)", async () => {
    db.seedFirst("SELECT id FROM project WHERE slug", ["my-app", teamId], {
      id: "existing-id",
    });
    const res = await req("POST", "/projects", { slug: "my-app" });
    expect(res.status).toBe(409);
  });

  test("autoResolveSlug falls back to slug-2 when base is taken", async () => {
    // Seed: "my-app" is taken, "my-app-2" is free.
    db.seedFirst("SELECT id FROM project WHERE slug", ["my-app", teamId], {
      id: "existing-id",
    });
    db.seedFirst("SELECT id FROM project WHERE slug", ["my-app-2", teamId], null);

    const res = await req("POST", "/projects", {
      slug: "my-app",
      autoResolveSlug: true,
    });
    expect(res.status).toBe(201);

    const executed = db.getExecuted();
    const insert = executed.find((q) => q.sql.includes("INSERT INTO project"));
    expect(insert).toBeDefined();
    // The INSERT should use the resolved slug, not the original request
    expect(insert!.args).toContain("my-app-2");
    expect(insert!.args).not.toContain("my-app");
  });

  test("autoResolveSlug walks past multiple collisions to find a free suffix", async () => {
    // Seed: my-app, my-app-2, my-app-3 taken; my-app-4 free.
    db.seedFirst("SELECT id FROM project WHERE slug", ["my-app", teamId], { id: "p1" });
    db.seedFirst("SELECT id FROM project WHERE slug", ["my-app-2", teamId], { id: "p2" });
    db.seedFirst("SELECT id FROM project WHERE slug", ["my-app-3", teamId], { id: "p3" });
    db.seedFirst("SELECT id FROM project WHERE slug", ["my-app-4", teamId], null);

    const res = await req("POST", "/projects", {
      slug: "my-app",
      autoResolveSlug: true,
    });
    expect(res.status).toBe(201);

    const executed = db.getExecuted();
    const insert = executed.find((q) => q.sql.includes("INSERT INTO project"));
    expect(insert!.args).toContain("my-app-4");
  });

  test("autoResolveSlug does not append suffix when base is already free", async () => {
    db.seedFirst("SELECT id FROM project WHERE slug", ["my-app", teamId], null);

    const res = await req("POST", "/projects", {
      slug: "my-app",
      autoResolveSlug: true,
    });
    expect(res.status).toBe(201);

    const executed = db.getExecuted();
    const insert = executed.find((q) => q.sql.includes("INSERT INTO project"));
    expect(insert!.args).toContain("my-app");
    expect(insert!.args).not.toContain("my-app-2");
  });

  test("persists githubRepo field when provided", async () => {
    db.seedFirst("SELECT id FROM project WHERE slug", ["my-app", teamId], null);

    const res = await req("POST", "/projects", {
      slug: "my-app",
      githubRepo: "linyiru/my-app",
    });
    expect(res.status).toBe(201);

    const executed = db.getExecuted();
    const insert = executed.find((q) => q.sql.includes("INSERT INTO project"));
    expect(insert!.args).toContain("linyiru/my-app");
  });
});

describe("GET /projects", () => {
  test("lists projects for team", async () => {
    db.seedAll("SELECT * FROM project WHERE organizationId", [teamId], {
      results: [
        { id: "p1", slug: "app-one", organization_id: teamId },
        { id: "p2", slug: "app-two", organization_id: teamId },
      ],
    });

    const res = await req("GET", "/projects");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json).toHaveLength(2);
  });

  test("returns empty array when no projects", async () => {
    const res = await req("GET", "/projects");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json).toEqual([]);
  });
});

describe("GET /projects/:idOrSlug", () => {
  test("returns project by slug", async () => {
    db.seedFirst("SELECT * FROM project WHERE", ["my-app", "my-app", teamId], {
      id: "p1",
      slug: "my-app",
      organization_id: teamId,
    });

    const res = await req("GET", "/projects/my-app");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.slug).toBe("my-app");
  });

  test("returns 404 for non-existent project", async () => {
    const res = await req("GET", "/projects/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /projects/:idOrSlug", () => {
  test("deletes existing project", async () => {
    db.seedFirst("SELECT id FROM project WHERE", ["my-app", "my-app", teamId], {
      id: "p1",
    });

    const res = await req("DELETE", "/projects/my-app");
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
  });

  test("returns 404 for non-existent project", async () => {
    const res = await req("DELETE", "/projects/nonexistent");
    expect(res.status).toBe(404);
  });
});

// --- Health ---

describe("GET /health", () => {
  test("returns ok", async () => {
    const res = await app.request("/health", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.status).toBe("ok");
  });
});

// --- RBAC ---

describe("RBAC", () => {
  test("member role cannot create project (403)", async () => {
    db.reset();
    seedMemberRole(db, "member");

    const res = await req("POST", "/projects", { slug: "new-app" });
    expect(res.status).toBe(403);
    const json = await res.json() as any;
    expect(json.error).toBe("forbidden");
  });

  test("member role cannot delete project (403)", async () => {
    db.reset();
    seedMemberRole(db, "member");

    const res = await req("DELETE", "/projects/some-app");
    expect(res.status).toBe(403);
  });

  test("admin role can create project but cannot delete", async () => {
    // Admin can create
    db.reset();
    seedMemberRole(db, "admin");
    db.seedFirst("SELECT id FROM project WHERE slug", ["new-app", teamId], null);

    const createRes = await req("POST", "/projects", { slug: "new-app" });
    expect(createRes.status).toBe(201);

    // Admin cannot delete
    db.reset();
    seedMemberRole(db, "admin");

    const deleteRes = await req("DELETE", "/projects/some-app");
    expect(deleteRes.status).toBe(403);
  });

  test("owner role can do everything", async () => {
    // seedMemberRole defaults to owner — already tested by all other tests
    db.seedFirst("SELECT id FROM project WHERE slug", ["new-app", teamId], null);

    const res = await req("POST", "/projects", { slug: "new-app" });
    expect(res.status).toBe(201);
  });

  test("non-member gets 403", async () => {
    db.reset();
    // Don't seed any member role

    const res = await req("POST", "/projects", { slug: "new-app" });
    expect(res.status).toBe(403);
    const json = await res.json() as any;
    expect(json.message).toContain("Not a member");
  });
});
