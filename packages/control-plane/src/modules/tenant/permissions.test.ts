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

beforeEach(() => {
  db = createMockD1();
  env = createTestEnv(db);
});

const executionCtx = {
  waitUntil: (_p: Promise<unknown>) => {},
  passThroughOnException: () => {},
};

function makeApp(role: string) {
  seedMemberRole(db, role);
  return createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
}

function req(app: ReturnType<typeof createTestApp>, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, env, executionCtx as any);
}

// --- Project CRUD permissions ---

describe("project:create permission", () => {
  test("owner can create project", async () => {
    const app = makeApp("owner");
    const res = await req(app, "POST", "/projects", { slug: "new-app" });
    expect(res.status).not.toBe(403);
  });

  test("admin can create project", async () => {
    const app = makeApp("admin");
    const res = await req(app, "POST", "/projects", { slug: "new-app" });
    expect(res.status).not.toBe(403);
  });

  test("member cannot create project", async () => {
    const app = makeApp("member");
    const res = await req(app, "POST", "/projects", { slug: "new-app" });
    expect(res.status).toBe(403);
  });
});

describe("project:delete permission", () => {
  const PROJECT_ID = "proj-1";

  function seedProject() {
    db.seedFirst("SELECT id FROM project WHERE", [PROJECT_ID, PROJECT_ID, TEST_TEAM.id], {
      id: PROJECT_ID,
    });
  }

  test("owner can delete project", async () => {
    const app = makeApp("owner");
    seedProject();
    const res = await req(app, "DELETE", `/projects/${PROJECT_ID}`);
    expect(res.status).not.toBe(403);
  });

  test("admin cannot delete project", async () => {
    const app = makeApp("admin");
    const res = await req(app, "DELETE", `/projects/${PROJECT_ID}`);
    expect(res.status).toBe(403);
  });

  test("member cannot delete project", async () => {
    const app = makeApp("member");
    const res = await req(app, "DELETE", `/projects/${PROJECT_ID}`);
    expect(res.status).toBe(403);
  });
});

// --- Deploy permissions ---

describe("deploy:create permission", () => {
  const PROJECT_ID = "proj-1";

  function seedProjectForDeploy() {
    db.seedFirst("SELECT * FROM project WHERE", [PROJECT_ID, PROJECT_ID, TEST_TEAM.id], {
      id: PROJECT_ID,
      slug: "my-app",
    });
    db.seedFirst("SELECT MAX(version)", [PROJECT_ID], { max_version: 0 });
  }

  test("member can create deployment", async () => {
    const app = makeApp("member");
    seedProjectForDeploy();
    const res = await req(app, "POST", `/projects/${PROJECT_ID}/deployments`);
    expect(res.status).not.toBe(403);
  });

  test("no-role user is denied", async () => {
    // Don't seed any member role → member lookup returns null → 403
    const app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
    seedProjectForDeploy();
    const res = await req(app, "POST", `/projects/${PROJECT_ID}/deployments`);
    expect(res.status).toBe(403);
  });
});

// --- Env var permissions ---

describe("envvar:manage permission", () => {
  const PROJECT_ID = "proj-1";

  function seedProject() {
    db.seedFirst("SELECT * FROM project WHERE", [PROJECT_ID, PROJECT_ID, TEST_TEAM.id], {
      id: PROJECT_ID,
      slug: "my-app",
    });
  }

  test("owner can set env var", async () => {
    const app = makeApp("owner");
    seedProject();
    const res = await req(app, "POST", `/projects/${PROJECT_ID}/env`, {
      key: "DATABASE_URL",
      value: "postgres://...",
    });
    expect(res.status).not.toBe(403);
  });

  test("admin can set env var", async () => {
    const app = makeApp("admin");
    seedProject();
    const res = await req(app, "POST", `/projects/${PROJECT_ID}/env`, {
      key: "DATABASE_URL",
      value: "postgres://...",
    });
    expect(res.status).not.toBe(403);
  });

  test("member cannot set env var", async () => {
    const app = makeApp("member");
    seedProject();
    const res = await req(app, "POST", `/projects/${PROJECT_ID}/env`, {
      key: "DATABASE_URL",
      value: "postgres://...",
    });
    expect(res.status).toBe(403);
  });
});

// --- Domain permissions ---

describe("domain:manage permission", () => {
  const PROJECT_ID = "proj-1";

  function seedProject() {
    db.seedFirst("SELECT id, slug FROM project WHERE", [PROJECT_ID, PROJECT_ID, TEST_TEAM.id], {
      id: PROJECT_ID,
      slug: "my-app",
    });
  }

  test("owner can add domain", async () => {
    const app = makeApp("owner");
    seedProject();
    const res = await req(app, "POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "app.example.com",
    });
    expect(res.status).not.toBe(403);
  });

  test("member cannot add domain", async () => {
    const app = makeApp("member");
    const res = await req(app, "POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "app.example.com",
    });
    expect(res.status).toBe(403);
  });

  test("member cannot delete domain", async () => {
    const app = makeApp("member");
    const res = await req(app, "DELETE", `/projects/${PROJECT_ID}/domains/dom-1`);
    expect(res.status).toBe(403);
  });
});
