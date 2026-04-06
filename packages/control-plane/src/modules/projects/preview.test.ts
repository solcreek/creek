import { describe, test, expect, beforeEach } from "vitest";
import { app } from "../../index.js";
import { createMockD1, createTestEnv, type MockD1 } from "../../test-helpers.js";

let db: MockD1;
let env: ReturnType<typeof createTestEnv>;

beforeEach(() => {
  db = createMockD1();
  env = createTestEnv(db);
});

describe("GET /preview/:slug/*", () => {
  test("uses productionDeploymentId", async () => {
    db.seedFirst("SELECT id, productionDeploymentId FROM project WHERE slug", ["my-app"], {
      id: "proj-1",
      productionDeploymentId: "deploy-1",
    });

    const res = await app.request("/preview/my-app/index.html", { method: "GET" }, env);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toBe("Not Found");
  });

  test("returns 404 when no production deployment", async () => {
    db.seedFirst("SELECT id, productionDeploymentId FROM project WHERE slug", ["my-app"], {
      id: "proj-1",
      productionDeploymentId: null,
    });

    const res = await app.request("/preview/my-app/index.html", { method: "GET" }, env);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain("no production deployment");
  });

  test("returns 404 for non-existent project", async () => {
    const res = await app.request("/preview/nonexistent/index.html", { method: "GET" }, env);
    expect(res.status).toBe(404);
  });

  test("serves asset from R2 when found", async () => {
    db.seedFirst("SELECT id, productionDeploymentId FROM project WHERE slug", ["my-app"], {
      id: "proj-1",
      productionDeploymentId: "deploy-1",
    });

    const r2 = env.ASSETS as any;
    await r2.put("proj-1/deploy-1/index.html", "<h1>Hello</h1>");

    const res = await app.request("/preview/my-app/index.html", { method: "GET" }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });
});
