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
let teamSlug: string;

// Mock execution context for waitUntil
const executionCtx = {
  waitUntil: (_p: Promise<unknown>) => {},
  passThroughOnException: () => {},
};

beforeEach(() => {
  db = createMockD1();
  env = createTestEnv(db);
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
  teamId = TEST_TEAM.id;
  teamSlug = TEST_TEAM.slug;
  seedMemberRole(db);
});

function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, env, executionCtx as any);
}

const PROJECT_ID = "proj-1";
const DEPLOYMENT_ID = "deploy-1";

function seedProject() {
  db.seedFirst("SELECT * FROM project WHERE", [PROJECT_ID, PROJECT_ID, teamId], {
    id: PROJECT_ID,
    slug: "my-app",
    framework: null,
    productionBranch: "main",
    organization_id: teamId,
  });
}

// --- POST /projects/:id/deployments ---

describe("POST /projects/:id/deployments", () => {
  test("creates deployment with queued status", async () => {
    seedProject();
    db.seedFirst("SELECT MAX(version)", [PROJECT_ID], { max_version: 2 });

    const res = await req("POST", `/projects/${PROJECT_ID}/deployments`);
    expect(res.status).toBe(201);
    const json = await res.json() as any;
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

  test("returns 202 for queued deployment", async () => {
    seedProject();
    db.seedFirst("SELECT * FROM deployment WHERE id", [DEPLOYMENT_ID, PROJECT_ID], {
      id: DEPLOYMENT_ID,
      status: "queued",
      branch: null,
    });
    db.seedFirst("SELECT plan FROM organization", [teamId], { plan: "free" });

    const res = await req(
      "PUT",
      `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/bundle`,
      bundle,
    );
    expect(res.status).toBe(202);
    const json = await res.json() as any;
    expect(json.deployment).toBeDefined();
  });

  test("allows retry on failed deployment", async () => {
    seedProject();
    db.seedFirst("SELECT * FROM deployment WHERE id", [DEPLOYMENT_ID, PROJECT_ID], {
      id: DEPLOYMENT_ID,
      status: "failed",
      branch: null,
    });
    db.seedFirst("SELECT plan FROM organization", [teamId], { plan: "free" });

    const res = await req(
      "PUT",
      `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/bundle`,
      bundle,
    );
    expect(res.status).toBe(202);
  });

  test("rejects 409 when deployment is in progress", async () => {
    for (const status of ["uploading", "provisioning", "deploying"]) {
      db.reset();
      seedProject();
      db.seedFirst("SELECT * FROM deployment WHERE id", [DEPLOYMENT_ID, PROJECT_ID], {
        id: DEPLOYMENT_ID,
        status,
        branch: null,
      });

      const res = await req(
        "PUT",
        `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/bundle`,
        bundle,
      );
      expect(res.status).toBe(409);
    }
  });

  test("rejects 400 when deployment is already active", async () => {
    seedProject();
    db.seedFirst("SELECT * FROM deployment WHERE id", [DEPLOYMENT_ID, PROJECT_ID], {
      id: DEPLOYMENT_ID,
      status: "active",
      branch: null,
    });

    const res = await req(
      "PUT",
      `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/bundle`,
      bundle,
    );
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.message).toContain("already completed");
  });

  test("returns 404 for non-existent deployment", async () => {
    seedProject();

    const res = await req(
      "PUT",
      `/projects/${PROJECT_ID}/deployments/nonexistent/bundle`,
      bundle,
    );
    expect(res.status).toBe(404);
  });

  // --- Bundle guardrails ---

  test("rejects invalid JSON", async () => {
    seedProject();
    db.seedFirst("SELECT * FROM deployment WHERE id", [DEPLOYMENT_ID, PROJECT_ID], {
      id: DEPLOYMENT_ID,
      status: "queued",
      branch: null,
    });

    const res = await app.request(
      `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/bundle`,
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "not json {{{",
      },
      env,
      executionCtx as any,
    );
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.message).toContain("Invalid JSON");
  });

  test("rejects bundle without manifest", async () => {
    seedProject();
    db.seedFirst("SELECT * FROM deployment WHERE id", [DEPLOYMENT_ID, PROJECT_ID], {
      id: DEPLOYMENT_ID,
      status: "queued",
      branch: null,
    });

    const res = await req(
      "PUT",
      `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/bundle`,
      { assets: { "index.html": btoa("hi") } },
    );
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.message).toContain("manifest");
  });

  test("rejects bundle without assets", async () => {
    seedProject();
    db.seedFirst("SELECT * FROM deployment WHERE id", [DEPLOYMENT_ID, PROJECT_ID], {
      id: DEPLOYMENT_ID,
      status: "queued",
      branch: null,
    });

    const res = await req(
      "PUT",
      `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}/bundle`,
      { manifest: { assets: ["index.html"], hasWorker: false, entrypoint: null }, assets: {} },
    );
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.message).toContain("at least one asset");
  });
});

// --- GET /projects/:id/deployments/:id ---

describe("GET /deployments/:id", () => {
  test("returns deployment with url and previewUrl", async () => {
    db.seedFirst("SELECT * FROM project WHERE", [PROJECT_ID, PROJECT_ID, teamId], {
      id: PROJECT_ID,
      slug: "my-app",
      productionDeploymentId: DEPLOYMENT_ID,
    });
    db.seedFirst("SELECT * FROM deployment WHERE id", [DEPLOYMENT_ID, PROJECT_ID], {
      id: DEPLOYMENT_ID,
      status: "active",
      failedStep: null,
      errorMessage: null,
    });

    const res = await req("GET", `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.deployment).toBeDefined();
    expect(json.url).toContain("my-app");
    expect(json.previewUrl).toBeDefined();
  });

  test("returns null url for non-production deployment", async () => {
    db.seedFirst("SELECT * FROM project WHERE", [PROJECT_ID, PROJECT_ID, teamId], {
      id: PROJECT_ID,
      slug: "my-app",
      productionDeploymentId: "other-deploy",
    });
    db.seedFirst("SELECT * FROM deployment WHERE id", [DEPLOYMENT_ID, PROJECT_ID], {
      id: DEPLOYMENT_ID,
      status: "active",
    });

    const res = await req("GET", `/projects/${PROJECT_ID}/deployments/${DEPLOYMENT_ID}`);
    const json = await res.json() as any;
    expect(json.url).toBeNull();
  });
});

// --- GET /projects/:id/deployments ---

describe("GET /deployments list", () => {
  test("lists deployments for project and attaches a live URL on active rows", async () => {
    db.seedFirst("FROM project WHERE", [PROJECT_ID, PROJECT_ID, teamId], {
      id: PROJECT_ID,
      slug: "my-app",
      productionDeploymentId: "d1abcdef12345",
    });
    db.seedAll("SELECT * FROM deployment WHERE projectId", [PROJECT_ID], {
      results: [
        { id: "d1abcdef12345", version: 2, status: "active" },
        { id: "d2xyz9876", version: 1, status: "failed" },
        { id: "d3preview000", version: 0, status: "active" },
      ],
    });

    const res = await req("GET", `/projects/${PROJECT_ID}/deployments`);
    expect(res.status).toBe(200);
    const json = await res.json() as Array<{ id: string; status: string; url: string | null }>;
    expect(json).toHaveLength(3);

    // Active production deployment → bare slug URL
    const prod = json.find((d) => d.id === "d1abcdef12345")!;
    expect(prod.url).toBe(`https://my-app-${TEST_TEAM.slug}.${"bycreek.com"}`);

    // Failed deployment → no URL
    const failed = json.find((d) => d.id === "d2xyz9876")!;
    expect(failed.url).toBeNull();

    // Active non-production → preview URL with 8-char short id
    const preview = json.find((d) => d.id === "d3preview000")!;
    expect(preview.url).toBe(
      `https://my-app-d3previe-${TEST_TEAM.slug}.${"bycreek.com"}`,
    );
  });
});
