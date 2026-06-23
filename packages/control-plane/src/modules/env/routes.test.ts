import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLocalTestEnv, seedTestData, seedProject, type LocalTestEnv } from "../../local/test-env.js";
import { createTestApp, TEST_USER, TEST_TEAM } from "../../test-helpers.js";

let testEnv: LocalTestEnv;
let app: ReturnType<typeof createTestApp>;
let teamId: string;

beforeEach(() => {
  testEnv = createLocalTestEnv();
  testEnv.env = { ...testEnv.env, ENCRYPTION_KEY: "test-key-for-env-vars" };
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

const PROJECT_ID = "proj-1";

function seedTestProject() {
  seedProject(testEnv, "proj-1-slug", { id: PROJECT_ID });
}

describe("GET /projects/:id/env", () => {
  test("lists env vars with masked values", async () => {
    seedTestProject();
    // Insert env vars directly into the real DB
    testEnv.db.db.exec(
      `INSERT INTO environment_variable (projectId, key, encryptedValue) VALUES ('${PROJECT_ID}', 'DATABASE_URL', 'enc-db-url')`,
    );
    testEnv.db.db.exec(
      `INSERT INTO environment_variable (projectId, key, encryptedValue) VALUES ('${PROJECT_ID}', 'API_KEY', 'enc-api-key')`,
    );

    const res = await req("GET", `/projects/${PROJECT_ID}/env`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json).toHaveLength(2);
    expect(json[0].key).toBe("API_KEY");
    // Value should be masked, not the encrypted blob
    expect(json[0].value).not.toContain("enc-");
  });

  test("returns 404 for non-existent project", async () => {
    const res = await req("GET", "/projects/nonexistent/env");
    expect(res.status).toBe(404);
  });
});

describe("POST /projects/:id/env", () => {
  test("sets an env var", async () => {
    seedTestProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/env`, {
      key: "DATABASE_URL",
      value: "postgres://...",
    });
    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.key).toBe("DATABASE_URL");

    // Verify the env var was actually inserted in the real DB
    const row = testEnv.db.db.prepare(
      "SELECT key, encryptedValue FROM environment_variable WHERE projectId = ? AND key = ?",
    ).get(PROJECT_ID, "DATABASE_URL") as any;
    expect(row).toBeDefined();
    expect(row.key).toBe("DATABASE_URL");
    expect(row.encryptedValue).toBeTruthy();
  });

  test("rejects invalid key format", async () => {
    seedTestProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/env`, {
      key: "invalid-key",
      value: "value",
    });
    expect(res.status).toBe(400);
  });

  test("rejects missing value", async () => {
    seedTestProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/env`, {
      key: "MY_KEY",
    });
    expect(res.status).toBe(400);
  });

  test("member role cannot set env vars (403)", async () => {
    // Re-seed with member role
    testEnv.db.db.exec("DELETE FROM member");
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT INTO member (id, userId, organizationId, role, createdAt) VALUES ('mem-2', '${TEST_USER.id}', '${teamId}', 'member', ${now})`,
    );
    seedTestProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/env`, {
      key: "SECRET",
      value: "val",
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /projects/:id/env/:key", () => {
  test("deletes an env var", async () => {
    seedTestProject();
    // Insert an env var to delete
    testEnv.db.db.exec(
      `INSERT INTO environment_variable (projectId, key, encryptedValue) VALUES ('${PROJECT_ID}', 'DATABASE_URL', 'enc-value')`,
    );

    const res = await req("DELETE", `/projects/${PROJECT_ID}/env/DATABASE_URL`);
    expect(res.status).toBe(200);

    // Verify it's actually gone
    const row = testEnv.db.db.prepare(
      "SELECT key FROM environment_variable WHERE projectId = ? AND key = ?",
    ).get(PROJECT_ID, "DATABASE_URL");
    expect(row).toBeUndefined();
  });

  test("member role cannot delete env vars (403)", async () => {
    // Re-seed with member role
    testEnv.db.db.exec("DELETE FROM member");
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT INTO member (id, userId, organizationId, role, createdAt) VALUES ('mem-2', '${TEST_USER.id}', '${teamId}', 'member', ${now})`,
    );
    seedTestProject();

    const res = await req("DELETE", `/projects/${PROJECT_ID}/env/SECRET`);
    expect(res.status).toBe(403);
  });
});

// Regression for the SameSite=none CSRF gap: a cross-site page must not be
// able to drive a state-changing control-plane route even with the victim's
// session cookie attached. originGuard rejects before the route runs.
describe("CSRF origin guard on /env routes", () => {
  function reqWithOrigin(
    method: string,
    path: string,
    origin: string,
    contentType: string,
    body?: unknown,
  ) {
    const init: RequestInit = { method, headers: { Origin: origin } };
    if (body) {
      (init.headers as Record<string, string>)["Content-Type"] = contentType;
      init.body = JSON.stringify(body);
    }
    return app.request(path, init, testEnv.env);
  }

  test("cross-origin POST with text/plain (no-preflight trick) → 403", async () => {
    seedTestProject();
    const res = await reqWithOrigin(
      "POST",
      `/projects/${PROJECT_ID}/env`,
      "https://evil.com",
      "text/plain",
      { key: "STOLEN", value: "x" },
    );
    expect(res.status).toBe(403);

    // The write must not have landed.
    const row = testEnv.db.db.prepare(
      "SELECT key FROM environment_variable WHERE projectId = ? AND key = ?",
    ).get(PROJECT_ID, "STOLEN");
    expect(row).toBeUndefined();
  });

  test("cross-origin DELETE → 403", async () => {
    const res = await reqWithOrigin(
      "DELETE",
      `/projects/${PROJECT_ID}/env/DATABASE_URL`,
      "https://evil.com",
      "application/json",
    );
    expect(res.status).toBe(403);
  });

  test("first-party Origin (app.creek.dev) is allowed through the guard", async () => {
    seedTestProject();
    const res = await reqWithOrigin(
      "POST",
      `/projects/${PROJECT_ID}/env`,
      "https://app.creek.dev",
      "application/json",
      { key: "OK_KEY", value: "v" },
    );
    expect(res.status).not.toBe(403);
  });
});
