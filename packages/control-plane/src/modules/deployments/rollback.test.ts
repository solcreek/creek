import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLocalTestEnv, seedTestData, seedProject, type LocalTestEnv } from "../../local/test-env.js";
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

const PROJECT_ID = "proj-1";
const CURRENT_DEPLOY = "deploy-current";
const PREVIOUS_DEPLOY = "deploy-previous";

function setupProject(productionDeploymentId: string | null = CURRENT_DEPLOY) {
  const now = Date.now();
  testEnv.db.db.exec(
    `INSERT OR IGNORE INTO project (id, slug, organizationId, productionDeploymentId, createdAt, updatedAt)
     VALUES ('${PROJECT_ID}', 'my-app', '${teamId}', ${productionDeploymentId === null ? "NULL" : `'${productionDeploymentId}'`}, ${now}, ${now})`,
  );
}

function setupDeployment(id: string, status = "active", version = 1) {
  const now = Date.now();
  testEnv.db.db.exec(
    `INSERT OR IGNORE INTO deployment (id, projectId, version, status, triggerType, createdAt, updatedAt)
     VALUES ('${id}', '${PROJECT_ID}', ${version}, '${status}', 'cli', ${now}, ${now})`,
  );
}

describe("POST /projects/:id/rollback", () => {
  test("rolls back to specified deployment", async () => {
    setupProject();
    setupDeployment(CURRENT_DEPLOY, "active", 1);
    setupDeployment(PREVIOUS_DEPLOY, "active", 2);

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {
      deploymentId: PREVIOUS_DEPLOY,
    });

    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.ok).toBe(true);
    expect(body.rolledBackTo).toBe(PREVIOUS_DEPLOY);
    expect(body.previousDeploymentId).toBe(CURRENT_DEPLOY);
    expect(body.url).toContain("my-app");
  });

  test("rolls back to previous deployment when no ID specified", async () => {
    setupProject();
    setupDeployment(CURRENT_DEPLOY, "active", 1);
    setupDeployment(PREVIOUS_DEPLOY, "active", 2);

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {});

    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.ok).toBe(true);
    expect(body.rolledBackTo).toBe(PREVIOUS_DEPLOY);
  });

  test("stores rollback message", async () => {
    setupProject();
    setupDeployment(CURRENT_DEPLOY, "active", 1);
    setupDeployment(PREVIOUS_DEPLOY, "active", 2);

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {
      deploymentId: PREVIOUS_DEPLOY,
      message: "revert bad deploy",
    });

    expect(res.status).toBe(200);
    // Verify the rollback deployment record was created with the message
    const row = testEnv.db.db.prepare(
      "SELECT commitMessage FROM deployment WHERE triggerType = 'rollback' AND projectId = ?",
    ).get(PROJECT_ID) as { commitMessage: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.commitMessage).toBe("revert bad deploy");
  });

  test("creates deployment record with rollback trigger type", async () => {
    setupProject();
    setupDeployment(CURRENT_DEPLOY, "active", 1);
    setupDeployment(PREVIOUS_DEPLOY, "active", 2);

    await req("POST", `/projects/${PROJECT_ID}/rollback`, {
      deploymentId: PREVIOUS_DEPLOY,
    });

    const row = testEnv.db.db.prepare(
      "SELECT triggerType FROM deployment WHERE triggerType = 'rollback' AND projectId = ?",
    ).get(PROJECT_ID) as { triggerType: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.triggerType).toBe("rollback");
  });

  test("rejects when project not found", async () => {
    const res = await req("POST", `/projects/nonexistent/rollback`, {});
    expect(res.status).toBe(404);
  });

  test("rejects when no production deployment exists", async () => {
    setupProject(null);

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {});
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe("no_production");
  });

  test("rejects when no previous deployment available", async () => {
    setupProject();
    setupDeployment(CURRENT_DEPLOY, "active", 1);
    // Only the current deploy exists — no previous

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {});
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe("no_previous");
  });

  test("rejects rollback to non-active deployment", async () => {
    setupProject();
    setupDeployment(CURRENT_DEPLOY, "active", 1);
    setupDeployment("deploy-failed", "failed", 2);

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {
      deploymentId: "deploy-failed",
    });
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe("invalid_target");
  });

  test("rejects rollback to current production (no-op)", async () => {
    setupProject();
    setupDeployment(CURRENT_DEPLOY, "active", 1);

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {
      deploymentId: CURRENT_DEPLOY,
    });
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe("already_production");
  });

  test("rejects rollback to non-existent deployment", async () => {
    setupProject();
    setupDeployment(CURRENT_DEPLOY, "active", 1);
    // Don't seed the target deployment

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {
      deploymentId: "nonexistent",
    });
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe("invalid_target");
  });
});
