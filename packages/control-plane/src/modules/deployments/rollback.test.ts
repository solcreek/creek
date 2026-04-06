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
const CURRENT_DEPLOY = "deploy-current";
const PREVIOUS_DEPLOY = "deploy-previous";

function seedProject(productionDeploymentId: string | null = CURRENT_DEPLOY) {
  db.seedFirst("SELECT * FROM project WHERE", [PROJECT_ID, PROJECT_ID, teamId], {
    id: PROJECT_ID,
    slug: "my-app",
    productionDeploymentId,
    organizationId: teamId,
  });
}

function seedDeployment(id: string, status = "active", version = 1) {
  db.seedFirst("SELECT * FROM deployment WHERE id = ?", [id, PROJECT_ID], {
    id,
    projectId: PROJECT_ID,
    status,
    version,
  });
}

function seedMaxVersion(v: number) {
  db.seedFirst("SELECT MAX(version)", [PROJECT_ID], { v });
}

function seedPreviousDeploy() {
  db.seedFirst(
    "SELECT id FROM deployment WHERE projectId = ?",
    [PROJECT_ID, CURRENT_DEPLOY],
    { id: PREVIOUS_DEPLOY },
  );
}

describe("POST /projects/:id/rollback", () => {
  test("rolls back to specified deployment", async () => {
    seedProject();
    seedDeployment(PREVIOUS_DEPLOY, "active", 2);
    seedMaxVersion(3);

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
    seedProject();
    seedPreviousDeploy();
    seedDeployment(PREVIOUS_DEPLOY, "active", 2);
    seedMaxVersion(3);

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {});

    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.ok).toBe(true);
    expect(body.rolledBackTo).toBe(PREVIOUS_DEPLOY);
  });

  test("stores rollback message", async () => {
    seedProject();
    seedDeployment(PREVIOUS_DEPLOY, "active", 2);
    seedMaxVersion(3);

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {
      deploymentId: PREVIOUS_DEPLOY,
      message: "revert bad deploy",
    });

    expect(res.status).toBe(200);
    // Verify the INSERT was called with the message
    const inserts = db.getExecuted().filter((e) => e.sql.includes("INSERT INTO deployment"));
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts[0].args).toContain("revert bad deploy");
  });

  test("creates deployment record with rollback trigger type", async () => {
    seedProject();
    seedDeployment(PREVIOUS_DEPLOY, "active", 2);
    seedMaxVersion(3);

    await req("POST", `/projects/${PROJECT_ID}/rollback`, {
      deploymentId: PREVIOUS_DEPLOY,
    });

    // batch() executes multiple statements — find the INSERT
    const allExec = db.getExecuted();
    const inserts = allExec.filter((e) => e.sql.includes("INSERT INTO deployment"));
    expect(inserts.length).toBeGreaterThan(0);
    // The SQL itself contains 'rollback' as a literal value
    expect(inserts[0].sql).toContain("'rollback'");
  });

  test("rejects when project not found", async () => {
    const res = await req("POST", `/projects/nonexistent/rollback`, {});
    expect(res.status).toBe(404);
  });

  test("rejects when no production deployment exists", async () => {
    seedProject(null);

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {});
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe("no_production");
  });

  test("rejects when no previous deployment available", async () => {
    seedProject();
    // Don't seed any previous deploy

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {});
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe("no_previous");
  });

  test("rejects rollback to non-active deployment", async () => {
    seedProject();
    // Don't seed the deployment — the query filters by status = 'active',
    // so a "failed" deployment won't be found

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {
      deploymentId: "deploy-failed",
    });
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe("invalid_target");
  });

  test("rejects rollback to current production (no-op)", async () => {
    seedProject();
    seedDeployment(CURRENT_DEPLOY, "active", 1);

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {
      deploymentId: CURRENT_DEPLOY,
    });
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe("already_production");
  });

  test("rejects rollback to non-existent deployment", async () => {
    seedProject();
    // Don't seed the target deployment

    const res = await req("POST", `/projects/${PROJECT_ID}/rollback`, {
      deploymentId: "nonexistent",
    });
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error).toBe("invalid_target");
  });
});
