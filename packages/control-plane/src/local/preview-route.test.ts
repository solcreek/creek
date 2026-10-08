import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createLocalTestEnv, seedTestData, seedProject, type LocalTestEnv } from "./test-env.js";
import { mountLocalPreview } from "./preview-route.js";
import { app as workerApp } from "../index.js";
import type { Env } from "../types.js";

let t: LocalTestEnv;

beforeEach(async () => {
  t = createLocalTestEnv();
  seedTestData(t);
  const projectId = seedProject(t, "site");
  await t.env.DB.prepare("UPDATE project SET productionDeploymentId = 'dep-1' WHERE id = ?")
    .bind(projectId)
    .run();
  await t.env.ASSETS.put(`${projectId}/dep-1/index.html`, "<h1>site</h1>");
  await t.env.ASSETS.put(`${projectId}/dep-1/app.css`, "h1{}");
});

afterEach(() => {
  t.cleanup();
});

describe("GET /preview/:slug/*", () => {
  it("is not served by the deployed Worker app", async () => {
    // Unauthenticated asset access by slug must not exist on api.creek.dev.
    const res = await workerApp.request("/preview/site/", {}, t.env);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<h1>site</h1>");
  });

  it("serves the production deployment when mounted for local dev", async () => {
    const local = new Hono<{ Bindings: Env }>();
    mountLocalPreview(local);

    const index = await local.request("/preview/site/", {}, t.env);
    expect(index.status).toBe(200);
    expect(await index.text()).toBe("<h1>site</h1>");

    const css = await local.request("/preview/site/app.css", {}, t.env);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");

    // SPA fallback for an unknown path.
    const deep = await local.request("/preview/site/some/route", {}, t.env);
    expect(await deep.text()).toBe("<h1>site</h1>");

    expect((await local.request("/preview/missing/", {}, t.env)).status).toBe(404);
  });

  it("answers 404 for a project with no production deployment or no assets", async () => {
    const local = new Hono<{ Bindings: Env }>();
    mountLocalPreview(local);

    seedProject(t, "draft");
    const draft = await local.request("/preview/draft/index.html", {}, t.env);
    expect(draft.status).toBe(404);
    expect(await draft.text()).toContain("no production deployment");

    const empty = seedProject(t, "empty");
    await t.env.DB.prepare("UPDATE project SET productionDeploymentId = 'dep-2' WHERE id = ?")
      .bind(empty)
      .run();
    const res = await local.request("/preview/empty/index.html", {}, t.env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });
});
