import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  createLocalTestEnv,
  seedTestData,
  seedProject,
  type LocalTestEnv,
} from "../../local/test-env.js";
import { createTestApp, TEST_USER, TEST_TEAM } from "../../test-helpers.js";

let testEnv: LocalTestEnv;

beforeEach(() => {
  testEnv = createLocalTestEnv();
  // Clear CLOUDFLARE_ZONE_ID so domain routes don't attempt real CF API calls
  testEnv.env.CLOUDFLARE_ZONE_ID = "";
});

afterEach(() => {
  testEnv.cleanup();
});

const executionCtx = {
  waitUntil: (_p: Promise<unknown>) => {},
  passThroughOnException: () => {},
};

function makeApp(role: string) {
  seedTestData(testEnv, { role });
  return createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
}

function req(app: ReturnType<typeof createTestApp>, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, testEnv.env, executionCtx as any);
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

  function setupProject() {
    seedProject(testEnv, "my-app", { id: PROJECT_ID });
  }

  test("owner can delete project", async () => {
    const app = makeApp("owner");
    setupProject();
    const res = await req(app, "DELETE", `/projects/${PROJECT_ID}`);
    expect(res.status).not.toBe(403);
  });

  test("admin cannot delete project", async () => {
    const app = makeApp("admin");
    setupProject();
    const res = await req(app, "DELETE", `/projects/${PROJECT_ID}`);
    expect(res.status).toBe(403);
  });

  test("member cannot delete project", async () => {
    const app = makeApp("member");
    setupProject();
    const res = await req(app, "DELETE", `/projects/${PROJECT_ID}`);
    expect(res.status).toBe(403);
  });
});

// --- Deploy permissions ---

describe("deploy:create permission", () => {
  const PROJECT_ID = "proj-1";

  function setupProjectForDeploy() {
    seedProject(testEnv, "my-app", { id: PROJECT_ID });
  }

  test("member can create deployment", async () => {
    const app = makeApp("member");
    setupProjectForDeploy();
    const res = await req(app, "POST", `/projects/${PROJECT_ID}/deployments`);
    expect(res.status).not.toBe(403);
  });

  test("no-role user is denied", async () => {
    // Seed org + user but no member row → member lookup returns null → 403
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('${TEST_USER.id}', 'Test User', '${TEST_USER.email}', 0, ${now}, ${now})`,
    );
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES ('${TEST_TEAM.id}', 'Test Org', '${TEST_TEAM.slug}', ${now})`,
    );
    const app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
    setupProjectForDeploy();
    const res = await req(app, "POST", `/projects/${PROJECT_ID}/deployments`);
    expect(res.status).toBe(403);
  });
});

// --- Env var permissions ---

describe("envvar:manage permission", () => {
  const PROJECT_ID = "proj-1";

  function setupProject() {
    seedProject(testEnv, "my-app", { id: PROJECT_ID });
  }

  test("owner can set env var", async () => {
    const app = makeApp("owner");
    setupProject();
    const res = await req(app, "POST", `/projects/${PROJECT_ID}/env`, {
      key: "DATABASE_URL",
      value: "postgres://...",
    });
    expect(res.status).not.toBe(403);
  });

  test("admin can set env var", async () => {
    const app = makeApp("admin");
    setupProject();
    const res = await req(app, "POST", `/projects/${PROJECT_ID}/env`, {
      key: "DATABASE_URL",
      value: "postgres://...",
    });
    expect(res.status).not.toBe(403);
  });

  test("member cannot set env var", async () => {
    const app = makeApp("member");
    setupProject();
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

  function setupProject() {
    seedProject(testEnv, "my-app", { id: PROJECT_ID });
  }

  test("owner can add domain", async () => {
    const app = makeApp("owner");
    setupProject();
    const res = await req(app, "POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "app.example.com",
    });
    expect(res.status).not.toBe(403);
  });

  test("member cannot add domain", async () => {
    const app = makeApp("member");
    setupProject();
    const res = await req(app, "POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "app.example.com",
    });
    expect(res.status).toBe(403);
  });

  test("member cannot delete domain", async () => {
    const app = makeApp("member");
    setupProject();
    const res = await req(app, "DELETE", `/projects/${PROJECT_ID}/domains/dom-1`);
    expect(res.status).toBe(403);
  });
});
