import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { deployToCreek } from "./creek-api";

// MSW mocks the Creek control-plane API so we can assert the remote builder's
// deploy flow (get-or-create project -> create deployment -> upload bundle ->
// poll status) without the network. Fabricated IDs only.
const API = "https://creek-api.test";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const bundle = { manifest: { assets: [] }, assets: {} };

function activeStatusHandlers(projectId: string) {
  return [
    http.post(`${API}/projects/:pid/deployments`, () =>
      HttpResponse.json({ deployment: { id: "dep-1" } }),
    ),
    http.put(`${API}/projects/:pid/deployments/:did/bundle`, () => new HttpResponse(null, { status: 202 })),
    http.get(`${API}/projects/${projectId}/deployments/dep-1`, () =>
      HttpResponse.json({
        url: "https://myapp-team.bycreek.test",
        previewUrl: "https://dep-1.bycreek.test",
        deployment: { status: "active" },
      }),
    ),
  ];
}

describe("deployToCreek", () => {
  it("deploys to an existing project and returns the live URLs", async () => {
    let sawApiKey = "";
    server.use(
      http.get(`${API}/projects/myapp`, ({ request }) => {
        sawApiKey = request.headers.get("x-api-key") ?? "";
        return HttpResponse.json({ id: "proj-1" });
      }),
      ...activeStatusHandlers("proj-1"),
    );

    const res = await deployToCreek(API, "tok-123", "myapp", "nextjs", bundle);

    expect(res).toEqual({
      success: true,
      url: "https://myapp-team.bycreek.test",
      previewUrl: "https://dep-1.bycreek.test",
      deploymentId: "dep-1",
      projectSlug: "myapp",
    });
    expect(sawApiKey).toBe("tok-123");
  });

  it("creates the project when it does not exist yet (GET 404 -> POST)", async () => {
    let created: unknown = null;
    server.use(
      http.get(`${API}/projects/newapp`, () => new HttpResponse(null, { status: 404 })),
      http.post(`${API}/projects`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ project: { id: "proj-2" } });
      }),
      ...activeStatusHandlers("proj-2"),
    );

    const res = await deployToCreek(API, "tok", "newapp", "vite", bundle);
    expect(res.success).toBe(true);
    expect(created).toEqual({ slug: "newapp", framework: "vite" });
  });

  it("returns a DeployError when the deployment fails", async () => {
    server.use(
      http.get(`${API}/projects/myapp`, () => HttpResponse.json({ id: "proj-1" })),
      http.post(`${API}/projects/:pid/deployments`, () => HttpResponse.json({ deployment: { id: "dep-1" } })),
      http.put(`${API}/projects/:pid/deployments/:did/bundle`, () => new HttpResponse(null, { status: 202 })),
      http.get(`${API}/projects/proj-1/deployments/dep-1`, () =>
        HttpResponse.json({
          deployment: { status: "failed", failedStep: "deploying", errorMessage: "No such module node:http" },
        }),
      ),
    );

    const res = await deployToCreek(API, "tok", "myapp", undefined, bundle);
    expect(res).toEqual({
      success: false,
      status: "failed",
      failedStep: "deploying",
      errorMessage: "No such module node:http",
    });
  });

  it("throws when project creation is rejected", async () => {
    server.use(
      http.get(`${API}/projects/myapp`, () => new HttpResponse(null, { status: 404 })),
      http.post(`${API}/projects`, () =>
        HttpResponse.json({ message: "slug taken" }, { status: 409 }),
      ),
    );
    await expect(deployToCreek(API, "tok", "myapp", "nextjs", bundle)).rejects.toThrow(/Failed to create project: slug taken/);
  });
});
