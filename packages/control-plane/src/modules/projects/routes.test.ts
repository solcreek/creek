import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  createLocalTestEnv,
  seedTestData,
  seedProject,
  type LocalTestEnv,
} from "../../local/test-env.js";
import { createTestApp, TEST_USER, TEST_TEAM } from "../../test-helpers.js";

let testEnv: LocalTestEnv;
let app: ReturnType<typeof createTestApp>;
let teamId: string;

beforeEach(() => {
  testEnv = createLocalTestEnv();
  seedTestData(testEnv);
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
  teamId = TEST_TEAM.id;
});

afterEach(() => {
  testEnv.cleanup();
});

function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, testEnv.env);
}

// --- Projects CRUD ---

describe("POST /projects", () => {
  test("creates project with valid slug", async () => {
    const res = await req("POST", "/projects", { slug: "my-app" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.project).toBeDefined();

    // Verify project actually exists in DB
    const row = testEnv.db.db
      .prepare("SELECT slug FROM project WHERE organizationId = ? AND slug = ?")
      .get(teamId, "my-app") as any;
    expect(row).toBeDefined();
    expect(row.slug).toBe("my-app");
  });

  test("rejects invalid slug (uppercase)", async () => {
    const res = await req("POST", "/projects", { slug: "My-App" });
    expect(res.status).toBe(400);
  });

  test("rejects slug containing -git-", async () => {
    const res = await req("POST", "/projects", { slug: "my-git-app" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.message).toContain("-git-");
  });

  test("rejects duplicate slug in same team (strict mode, default)", async () => {
    seedProject(testEnv, "my-app");
    const res = await req("POST", "/projects", { slug: "my-app" });
    expect(res.status).toBe(409);
  });

  test("autoResolveSlug falls back to slug-2 when base is taken", async () => {
    seedProject(testEnv, "my-app");

    const res = await req("POST", "/projects", {
      slug: "my-app",
      autoResolveSlug: true,
    });
    expect(res.status).toBe(201);

    // Verify the resolved slug is "my-app-2"
    const json = (await res.json()) as any;
    expect(json.project.slug).toBe("my-app-2");

    // Verify in DB
    const row = testEnv.db.db
      .prepare("SELECT slug FROM project WHERE organizationId = ? AND slug = ?")
      .get(teamId, "my-app-2") as any;
    expect(row).toBeDefined();
  });

  test("autoResolveSlug walks past multiple collisions to find a free suffix", async () => {
    seedProject(testEnv, "my-app");
    seedProject(testEnv, "my-app-2");
    seedProject(testEnv, "my-app-3");

    const res = await req("POST", "/projects", {
      slug: "my-app",
      autoResolveSlug: true,
    });
    expect(res.status).toBe(201);

    const json = (await res.json()) as any;
    expect(json.project.slug).toBe("my-app-4");
  });

  test("autoResolveSlug does not append suffix when base is already free", async () => {
    const res = await req("POST", "/projects", {
      slug: "my-app",
      autoResolveSlug: true,
    });
    expect(res.status).toBe(201);

    const json = (await res.json()) as any;
    expect(json.project.slug).toBe("my-app");
  });

  test("persists githubRepo field when provided", async () => {
    const res = await req("POST", "/projects", {
      slug: "my-app",
      githubRepo: "linyiru/my-app",
    });
    expect(res.status).toBe(201);

    // Verify githubRepo in DB
    const row = testEnv.db.db
      .prepare("SELECT githubRepo FROM project WHERE slug = ? AND organizationId = ?")
      .get("my-app", teamId) as any;
    expect(row).toBeDefined();
    expect(row.githubRepo).toBe("linyiru/my-app");
  });
});

describe("GET /projects", () => {
  test("lists projects for team", async () => {
    seedProject(testEnv, "app-one");
    seedProject(testEnv, "app-two");

    const res = await req("GET", "/projects");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toHaveLength(2);
  });

  test("returns empty array when no projects", async () => {
    const res = await req("GET", "/projects");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toEqual([]);
  });
});

describe("GET /projects/:idOrSlug", () => {
  test("returns project by slug", async () => {
    seedProject(testEnv, "my-app");

    const res = await req("GET", "/projects/my-app");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.slug).toBe("my-app");
  });

  test("returns 404 for non-existent project", async () => {
    const res = await req("GET", "/projects/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /projects/:idOrSlug", () => {
  test("deletes existing project", async () => {
    seedProject(testEnv, "my-app");

    const res = await req("DELETE", "/projects/my-app");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);

    // Verify it's actually gone
    const row = testEnv.db.db
      .prepare("SELECT id FROM project WHERE slug = ? AND organizationId = ?")
      .get("my-app", teamId);
    expect(row).toBeUndefined();
  });

  test("returns 404 for non-existent project", async () => {
    const res = await req("DELETE", "/projects/nonexistent");
    expect(res.status).toBe(404);
  });
});

// --- Health ---

describe("GET /health", () => {
  test("returns ok", async () => {
    const res = await app.request("/health", { method: "GET" }, testEnv.env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.status).toBe("ok");
  });
});

// --- RBAC ---

describe("RBAC", () => {
  test("member role cannot create project (403)", async () => {
    // Re-seed with member role
    testEnv.db.db.exec("DELETE FROM member");
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT INTO member (id, userId, organizationId, role, createdAt) VALUES ('mem-2', '${TEST_USER.id}', '${teamId}', 'member', ${now})`,
    );

    const res = await req("POST", "/projects", { slug: "new-app" });
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.error).toBe("forbidden");
  });

  test("member role cannot delete project (403)", async () => {
    testEnv.db.db.exec("DELETE FROM member");
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT INTO member (id, userId, organizationId, role, createdAt) VALUES ('mem-2', '${TEST_USER.id}', '${teamId}', 'member', ${now})`,
    );

    const res = await req("DELETE", "/projects/some-app");
    expect(res.status).toBe(403);
  });

  test("admin role can create project but cannot delete", async () => {
    // Admin can create
    testEnv.db.db.exec("DELETE FROM member");
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT INTO member (id, userId, organizationId, role, createdAt) VALUES ('mem-2', '${TEST_USER.id}', '${teamId}', 'admin', ${now})`,
    );

    const createRes = await req("POST", "/projects", { slug: "new-app" });
    expect(createRes.status).toBe(201);

    // Admin cannot delete
    const deleteRes = await req("DELETE", "/projects/some-app");
    expect(deleteRes.status).toBe(403);
  });

  test("owner role can do everything", async () => {
    // seedTestData defaults to owner — already tested by all other tests
    const res = await req("POST", "/projects", { slug: "new-app" });
    expect(res.status).toBe(201);
  });

  test("non-member gets 403", async () => {
    // Remove all member records
    testEnv.db.db.exec("DELETE FROM member");

    const res = await req("POST", "/projects", { slug: "new-app" });
    expect(res.status).toBe(403);
    const json = (await res.json()) as any;
    expect(json.message).toContain("Not a member");
  });
});
