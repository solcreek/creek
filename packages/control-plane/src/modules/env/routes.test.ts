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
  env = { ...createTestEnv(db), ENCRYPTION_KEY: "test-key-for-env-vars" };
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
  teamId = TEST_TEAM.id;
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

const PROJECT_ID = "proj-1";

function seedProject() {
  db.seedFirst("SELECT id FROM project WHERE", [PROJECT_ID, PROJECT_ID, teamId], {
    id: PROJECT_ID,
  });
}

describe("GET /projects/:id/env", () => {
  test("lists env vars with masked values", async () => {
    seedProject();
    db.seedAll("SELECT key, encryptedValue FROM environment_variable", [PROJECT_ID], {
      results: [
        { key: "DATABASE_URL", encrypted_value: "encrypted..." },
        { key: "API_KEY", encrypted_value: "encrypted..." },
      ],
    });

    const res = await req("GET", `/projects/${PROJECT_ID}/env`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json).toHaveLength(2);
    expect(json[0].key).toBe("DATABASE_URL");
    // Value should be masked, not the encrypted blob
    expect(json[0].value).not.toContain("encrypted");
  });

  test("returns 404 for non-existent project", async () => {
    const res = await req("GET", "/projects/nonexistent/env");
    expect(res.status).toBe(404);
  });
});

describe("POST /projects/:id/env", () => {
  test("sets an env var", async () => {
    seedProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/env`, {
      key: "DATABASE_URL",
      value: "postgres://...",
    });
    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.key).toBe("DATABASE_URL");
  });

  test("rejects invalid key format", async () => {
    seedProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/env`, {
      key: "invalid-key",
      value: "value",
    });
    expect(res.status).toBe(400);
  });

  test("rejects missing value", async () => {
    seedProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/env`, {
      key: "MY_KEY",
    });
    expect(res.status).toBe(400);
  });

  test("member role cannot set env vars (403)", async () => {
    db.reset();
    seedMemberRole(db, "member");
    seedProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/env`, {
      key: "SECRET",
      value: "val",
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /projects/:id/env/:key", () => {
  test("deletes an env var", async () => {
    seedProject();

    const res = await req("DELETE", `/projects/${PROJECT_ID}/env/DATABASE_URL`);
    expect(res.status).toBe(200);
  });

  test("member role cannot delete env vars (403)", async () => {
    db.reset();
    seedMemberRole(db, "member");
    seedProject();

    const res = await req("DELETE", `/projects/${PROJECT_ID}/env/SECRET`);
    expect(res.status).toBe(403);
  });
});
