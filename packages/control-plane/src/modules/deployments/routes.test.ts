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
let teamSlug: string;

// Mock execution context for waitUntil
const executionCtx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
};

beforeEach(() => {
  testEnv = createLocalTestEnv();
  seedTestData(testEnv);
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
  teamId = TEST_TEAM.id;
  teamSlug = TEST_TEAM.slug;
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
  return app.request(path, init, testEnv.env, executionCtx as any);
}

const PROJECT_ID = "proj-1";
const DEPLOYMENT_ID = "deploy-1";

function seedTestProject() {
  const now = Date.now();
  testEnv.db.db.exec(
    `INSERT OR IGNORE INTO project (id, slug, organizationId, productionBranch, createdAt, updatedAt)
     VALUES ('${PROJECT_ID}', 'my-app', '${teamId}', 'main', ${now}, ${now})`,
  );
}

// --- POST /projects/:id/deployments ---

describe("POST /projects/:id/deployments", () => {
  test("creates deployment with queued status", async () => {
    seedTestProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/deployments`);
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.deployment).toBeDefined();
  });

  test("returns 404 for non-existent project", async () => {
    const res = await req("POST", "/projects/nonexistent/deployments");
    expect(res.status).toBe(404);
  });
});

// --- PUT /projects/:id/deployments/:id/bundle ---

describe("PUT /bundle", () => {
  const bundle = {
    manifest: { assets: ["index.html"], hasWorker: false, entrypoint: null, renderMode: "spa" },
    workerScript: null,
    assets: { "index.html": btoa("<h1>hi</h1>") },
  };

  function seedDeployment(status: string, id: string = DEPLOYMENT_ID) {
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO deployment (id, projectId, version, status, triggerType, createdAt, updatedAt)
       VALUES ('${id}', '${PROJECT_ID}', 1, '${status}', 'cli', ${now}, ${now})`,
    );
  }

  test("returns 202 for queued deployment", async () => {
    seedTestProject();
    seedDeployment("queued");

    const res = await req(
      "PUT",
      `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/bundle`,
      bundle,
    );
    expect(res.status).toBe(202);
    const json = (await res.json()) as any;
    expect(json.deployment).toBeDefined();
  });

  test("allows retry on failed deployment", async () => {
    seedTestProject();
    seedDeployment("failed");

    const res = await req(
      "PUT",
      `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/bundle`,
      bundle,
    );
    expect(res.status).toBe(202);
  });

  test("rejects 409 when deployment is in progress", async () => {
    for (const status of ["uploading", "provisioning", "deploying"]) {
      // Fresh env per iteration
      testEnv.cleanup();
      testEnv = createLocalTestEnv();
      seedTestData(testEnv);
      seedTestProject();
      const depId = `dep-${status}`;
      const now = Date.now();
      testEnv.db.db.exec(
        `INSERT INTO deployment (id, projectId, version, status, triggerType, createdAt, updatedAt)
         VALUES ('${depId}', '${PROJECT_ID}', 1, '${status}', 'cli', ${now}, ${now})`,
      );

      const res = await app.request(
        `/projects/${PROJECT_ID}/deployments/${depId}/bundle`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bundle),
        },
        testEnv.env,
        executionCtx as any,
      );
      expect(res.status).toBe(409);
    }
  });

  test("rejects 400 when deployment is already active", async () => {
    seedTestProject();
    seedDeployment("active");

    const res = await req(
      "PUT",
      `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/bundle`,
      bundle,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.message).toContain("already completed");
  });

  test("returns 404 for non-existent deployment", async () => {
    seedTestProject();

    const res = await req("PUT", `/projects/${PROJECT_ID}/deployments/nonexistent/bundle`, bundle);
    expect(res.status).toBe(404);
  });

  // --- Bundle guardrails ---

  test("rejects invalid JSON", async () => {
    seedTestProject();
    seedDeployment("queued");

    const res = await app.request(
      `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/bundle`,
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "not json {{{",
      },
      testEnv.env,
      executionCtx as any,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.message).toContain("Invalid JSON");
  });

  test("rejects bundle without manifest", async () => {
    seedTestProject();
    seedDeployment("queued");

    const res = await req("PUT", `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/bundle`, {
      assets: { "index.html": btoa("hi") },
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.message).toContain("manifest");
  });

  test("rejects bundle without assets", async () => {
    seedTestProject();
    seedDeployment("queued");

    const res = await req("PUT", `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/bundle`, {
      manifest: { assets: ["index.html"], hasWorker: false, entrypoint: null },
      assets: {},
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.message).toContain("at least one asset");
  });
});

// --- GET /projects/:id/deployments/:id ---

describe("GET /deployments/:id", () => {
  test("returns deployment with url and previewUrl", async () => {
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO project (id, slug, organizationId, productionDeploymentId, productionBranch, createdAt, updatedAt)
       VALUES ('${PROJECT_ID}', 'my-app', '${teamId}', '${DEPLOYMENT_ID}', 'main', ${now}, ${now})`,
    );
    testEnv.db.db.exec(
      `INSERT INTO deployment (id, projectId, version, status, triggerType, createdAt, updatedAt)
       VALUES ('${DEPLOYMENT_ID}', '${PROJECT_ID}', 1, 'active', 'cli', ${now}, ${now})`,
    );

    const res = await req("GET", `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.deployment).toBeDefined();
    expect(json.url).toContain("my-app");
    expect(json.previewUrl).toBeDefined();
  });

  test("returns null url for non-production deployment", async () => {
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO project (id, slug, organizationId, productionDeploymentId, productionBranch, createdAt, updatedAt)
       VALUES ('${PROJECT_ID}', 'my-app', '${teamId}', 'other-deploy', 'main', ${now}, ${now})`,
    );
    testEnv.db.db.exec(
      `INSERT INTO deployment (id, projectId, version, status, triggerType, createdAt, updatedAt)
       VALUES ('${DEPLOYMENT_ID}', '${PROJECT_ID}', 1, 'active', 'cli', ${now}, ${now})`,
    );

    const res = await req("GET", `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}`);
    const json = (await res.json()) as any;
    expect(json.url).toBeNull();
  });

  test("attaches a classified errorCode + hint on a failed deployment", async () => {
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO project (id, slug, organizationId, productionDeploymentId, productionBranch, createdAt, updatedAt)
       VALUES ('${PROJECT_ID}', 'my-app', '${teamId}', '${DEPLOYMENT_ID}', 'main', ${now}, ${now})`,
    );
    // An activation-stage timeout — the customer's case. classifyDeployFailure
    // maps (deploying, "…deploy window…") to activation_timeout.
    testEnv.db.db.exec(
      `INSERT INTO deployment (id, projectId, version, status, triggerType, failedStep, errorMessage, createdAt, updatedAt)
       VALUES ('${DEPLOYMENT_ID}', '${PROJECT_ID}', 1, 'failed', 'cli', 'deploying', 'exceeded the 10-minute deploy window', ${now}, ${now})`,
    );

    const res = await req("GET", `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.errorCode).toBe("activation_timeout");
    expect(typeof json.errorHint).toBe("string");
    expect(json.errorHint.length).toBeGreaterThan(0);
  });

  test("omits errorCode/hint for a non-failed deployment", async () => {
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO project (id, slug, organizationId, productionDeploymentId, productionBranch, createdAt, updatedAt)
       VALUES ('${PROJECT_ID}', 'my-app', '${teamId}', '${DEPLOYMENT_ID}', 'main', ${now}, ${now})`,
    );
    testEnv.db.db.exec(
      `INSERT INTO deployment (id, projectId, version, status, triggerType, createdAt, updatedAt)
       VALUES ('${DEPLOYMENT_ID}', '${PROJECT_ID}', 1, 'active', 'cli', ${now}, ${now})`,
    );

    const res = await req("GET", `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}`);
    const json = (await res.json()) as any;
    expect(json.errorCode).toBeUndefined();
    expect(json.errorHint).toBeUndefined();
  });
});

// --- GET /projects/:id/deployments ---

describe("GET /deployments list", () => {
  test("lists deployments for project and attaches a live URL on active rows", async () => {
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO project (id, slug, organizationId, productionDeploymentId, productionBranch, createdAt, updatedAt)
       VALUES ('${PROJECT_ID}', 'my-app', '${teamId}', 'd1abcdef12345', 'main', ${now}, ${now})`,
    );
    testEnv.db.db.exec(
      `INSERT INTO deployment (id, projectId, version, status, triggerType, createdAt, updatedAt) VALUES
       ('d1abcdef12345', '${PROJECT_ID}', 2, 'active', 'cli', ${now}, ${now}),
       ('d2xyz9876', '${PROJECT_ID}', 1, 'failed', 'cli', ${now}, ${now}),
       ('d3preview000', '${PROJECT_ID}', 0, 'active', 'cli', ${now}, ${now})`,
    );

    const res = await req("GET", `/projects/${PROJECT_ID}/deployments`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ id: string; status: string; url: string | null }>;
    expect(json).toHaveLength(3);

    // Active production deployment -> bare slug URL
    const prod = json.find((d) => d.id === "d1abcdef12345")!;
    expect(prod.url).toBe(`https://my-app-${TEST_TEAM.slug}.${"bycreek.com"}`);

    // Failed deployment -> no URL
    const failed = json.find((d) => d.id === "d2xyz9876")!;
    expect(failed.url).toBeNull();

    // Active non-production -> preview URL with 8-char short id
    const preview = json.find((d) => d.id === "d3preview000")!;
    expect(preview.url).toBe(`https://my-app-d3previe-${TEST_TEAM.slug}.${"bycreek.com"}`);
  });
});
