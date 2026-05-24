import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { app } from "../../index.js";
import { createLocalTestEnv, seedTestData, seedProject, type LocalTestEnv } from "../../local/test-env.js";

let testEnv: LocalTestEnv;

beforeEach(() => {
  testEnv = createLocalTestEnv();
  seedTestData(testEnv);
});

afterEach(() => {
  testEnv.cleanup();
});

describe("GET /preview/:slug/*", () => {
  test("uses productionDeploymentId", async () => {
    const projId = seedProject(testEnv, "my-app");
    // Set productionDeploymentId on the project
    testEnv.db.db.exec(
      `UPDATE project SET productionDeploymentId = 'deploy-1' WHERE id = '${projId}'`,
    );

    const res = await app.request("/preview/my-app/index.html", { method: "GET" }, testEnv.env);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toBe("Not Found");
  });

  test("returns 404 when no production deployment", async () => {
    seedProject(testEnv, "my-app");
    // productionDeploymentId is NULL by default

    const res = await app.request("/preview/my-app/index.html", { method: "GET" }, testEnv.env);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain("no production deployment");
  });

  test("returns 404 for non-existent project", async () => {
    const res = await app.request("/preview/nonexistent/index.html", { method: "GET" }, testEnv.env);
    expect(res.status).toBe(404);
  });

  test("serves asset from R2 when found", async () => {
    const projId = seedProject(testEnv, "my-app");
    testEnv.db.db.exec(
      `UPDATE project SET productionDeploymentId = 'deploy-1' WHERE id = '${projId}'`,
    );

    const r2 = testEnv.env.ASSETS as any;
    await r2.put(`${projId}/deploy-1/index.html`, "<h1>Hello</h1>");

    const res = await app.request("/preview/my-app/index.html", { method: "GET" }, testEnv.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });
});
