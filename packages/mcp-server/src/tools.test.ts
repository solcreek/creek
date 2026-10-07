import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { registerTools, type ToolContext } from "./tools.js";
import type { Env } from "./types.js";

// MSW mocks the sandbox API so we can drive the MCP tool handlers (which the
// agent calls) without the network. We capture the registered handlers with
// a fake McpServer rather than standing up the full MCP transport.
const SANDBOX = "https://sandbox.test";

type Handler = (args: any) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function registerAndCapture(headers: Headers = new Headers()): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  const ctx: ToolContext = {
    env: {
      SANDBOX_API_URL: SANDBOX,
      INTERNAL_SECRET: "test-internal-secret",
      CONTROL_PLANE_URL: "https://cp.test",
    } as unknown as Env,
    clientIp: "203.0.113.7",
    requestHeaders: headers,
  };
  registerTools(fakeServer as never, ctx);
  return handlers;
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("MCP deploy tool", () => {
  it("deploys, polls to active, and returns the preview URL + forwards client IP", async () => {
    let deployHeaders: Record<string, string> = {};
    server.use(
      http.post(`${SANDBOX}/api/sandbox/deploy`, ({ request }) => {
        deployHeaders = Object.fromEntries(request.headers);
        return HttpResponse.json({ statusUrl: `${SANDBOX}/api/sandbox/sb-1/status` });
      }),
      http.get(`${SANDBOX}/api/sandbox/sb-1/status`, () =>
        HttpResponse.json({
          status: "active",
          sandboxId: "sb-1",
          previewUrl: "https://sb-1.creeksandbox.test",
          expiresInSeconds: 3600,
        }),
      ),
      http.get("https://sb-1.creeksandbox.test/", () =>
        HttpResponse.html("<html><head><title>hi</title></head><body><h1>hi</h1></body></html>"),
      ),
    );

    const deploy = registerAndCapture().get("deploy")!;
    const result = await deploy({ files: { "index.html": "<h1>hi</h1>" } });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.url).toBe("https://sb-1.creeksandbox.test");
    expect(payload.sandboxId).toBe("sb-1");
    expect(payload.proof).toMatchObject({ ok: true, status: 200, title: "hi" });
    // client IP forwarded so sandbox-api rate-limits the real caller
    expect(deployHeaders["x-forwarded-for"]).toBe("203.0.113.7");
    expect(deployHeaders["x-internal-secret"]).toBe("test-internal-secret");
  });

  it("returns an MCP error result when the sandbox API rejects the deploy", async () => {
    server.use(
      http.post(`${SANDBOX}/api/sandbox/deploy`, () =>
        HttpResponse.json({ message: "rate limited" }, { status: 429 }),
      ),
    );
    const deploy = registerAndCapture().get("deploy")!;
    const result = await deploy({ files: { "a.txt": "x" } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("rate limited");
  });

  it("marks isError when the preview URL is not live", async () => {
    server.use(
      http.post(`${SANDBOX}/api/sandbox/deploy`, () =>
        HttpResponse.json({ statusUrl: `${SANDBOX}/api/sandbox/sb-2/status` }),
      ),
      http.get(`${SANDBOX}/api/sandbox/sb-2/status`, () =>
        HttpResponse.json({
          status: "active",
          sandboxId: "sb-2",
          previewUrl: "https://sb-2.creeksandbox.test",
        }),
      ),
      http.get("https://sb-2.creeksandbox.test/", () => new HttpResponse("nope", { status: 502 })),
    );
    const deploy = registerAndCapture().get("deploy")!;
    const result = await deploy({ files: { "index.html": "<h1>x</h1>" } });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.url).toBe("https://sb-2.creeksandbox.test");
    expect(payload.error).toBe("verify_failed");
    expect(payload.proof.ok).toBe(false);
  });
});

describe("MCP deploy_demo tool", () => {
  it("includes the success message when the preview is live", async () => {
    server.use(
      http.post(`${SANDBOX}/api/sandbox/deploy`, () =>
        HttpResponse.json({ statusUrl: `${SANDBOX}/api/sandbox/sb-demo/status` }),
      ),
      http.get(`${SANDBOX}/api/sandbox/sb-demo/status`, () =>
        HttpResponse.json({
          status: "active",
          sandboxId: "sb-demo",
          previewUrl: "https://sb-demo.creeksandbox.test",
        }),
      ),
      http.get("https://sb-demo.creeksandbox.test/", () =>
        HttpResponse.html(
          "<html><head><title>Creek MCP Demo</title></head><body><h1>Deployed via MCP</h1></body></html>",
        ),
      ),
    );
    const deployDemo = registerAndCapture().get("deploy_demo")!;
    const result = await deployDemo({});
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.message).toBe("Demo deployed successfully.");
    expect(payload.proof.ok).toBe(true);
  });

  it("omits the success message when the preview is not live", async () => {
    server.use(
      http.post(`${SANDBOX}/api/sandbox/deploy`, () =>
        HttpResponse.json({ statusUrl: `${SANDBOX}/api/sandbox/sb-demo-fail/status` }),
      ),
      http.get(`${SANDBOX}/api/sandbox/sb-demo-fail/status`, () =>
        HttpResponse.json({
          status: "active",
          sandboxId: "sb-demo-fail",
          previewUrl: "https://sb-demo-fail.creeksandbox.test",
        }),
      ),
      http.get(
        "https://sb-demo-fail.creeksandbox.test/",
        () => new HttpResponse("nope", { status: 502 }),
      ),
    );
    const deployDemo = registerAndCapture().get("deploy_demo")!;
    const result = await deployDemo({});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBe("verify_failed");
    expect(payload.proof.ok).toBe(false);
    expect(payload.message).toBeUndefined();
  });
});

describe("MCP deploy_status tool", () => {
  it("reads a sandbox's status", async () => {
    server.use(
      http.get(`${SANDBOX}/api/sandbox/abc123/status`, () =>
        HttpResponse.json({
          status: "active",
          sandboxId: "abc123",
          previewUrl: "https://abc123.creeksandbox.test",
        }),
      ),
    );
    const status = registerAndCapture().get("deploy_status")!;
    const result = await status({ sandboxId: "abc123" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("abc123");
  });
});

describe("MCP authenticated tools", () => {
  it("list_resources without a request header returns not_authenticated", async () => {
    const list = registerAndCapture().get("list_resources")!;
    const result = await list({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("not_authenticated");
  });

  it("list_resources forwards Authorization Bearer as x-api-key", async () => {
    let saw: Record<string, string> = {};
    server.use(
      http.get("https://cp.test/resources", ({ request }) => {
        saw = Object.fromEntries(request.headers);
        return HttpResponse.json({ resources: [{ id: "r1", kind: "database", name: "db" }] });
      }),
    );
    const list = registerAndCapture(new Headers({ authorization: "Bearer ck_live_test" })).get(
      "list_resources",
    )!;
    const result = await list({});
    expect(result.isError).toBeUndefined();
    expect(saw["x-api-key"]).toBe("ck_live_test");
    expect(JSON.parse(result.content[0].text)[0].name).toBe("db");
  });

  it("list_projects without a header is not_authenticated", async () => {
    const list = registerAndCapture().get("list_projects")!;
    const result = await list({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("not_authenticated");
  });

  it("list_projects returns a slim project list", async () => {
    server.use(
      http.get("https://cp.test/projects", () =>
        HttpResponse.json([
          {
            id: "p1",
            slug: "hello",
            framework: "vite-react",
            productionDeploymentId: "d1",
            productionBranch: "main",
            githubRepo: "acme/hello",
            updatedAt: 1,
          },
        ]),
      ),
    );
    const list = registerAndCapture(new Headers({ authorization: "Bearer ck_live_test" })).get(
      "list_projects",
    )!;
    const result = await list({});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: true,
      projects: [{ slug: "hello", framework: "vite-react", productionDeploymentId: "d1" }],
    });
  });

  it("get_status includes latest deployment, productionUrl, and proof when live", async () => {
    server.use(
      http.get("https://cp.test/projects/hello", () =>
        HttpResponse.json({
          id: "p1",
          slug: "hello",
          framework: "vite-react",
          productionDeploymentId: "dep-new",
          productionBranch: "main",
        }),
      ),
      http.get("https://cp.test/projects/hello/deployments", () =>
        HttpResponse.json([
          {
            id: "dep-new",
            status: "active",
            version: 2,
            createdAt: 200,
            url: "https://hello.bycreek.test",
          },
          {
            id: "dep-old",
            status: "active",
            version: 1,
            createdAt: 100,
            url: "https://hello-dep-old.bycreek.test",
          },
        ]),
      ),
      http.get("https://hello.bycreek.test/", () =>
        HttpResponse.html("<html><head><title>hello live</title></head><body>ok</body></html>"),
      ),
    );
    const get = registerAndCapture(new Headers({ "x-api-key": "ck_live_test" })).get("get_status")!;
    const result = await get({ projectSlug: "hello" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: true,
      slug: "hello",
      productionDeploymentId: "dep-new",
      productionUrl: "https://hello.bycreek.test",
      live: true,
      pending: false,
      latestDeployment: {
        id: "dep-new",
        status: "active",
        version: 2,
        url: "https://hello.bycreek.test",
      },
      proof: { ok: true, status: 200, title: "hello live" },
    });
  });

  it("get_status does not GET proof while a newer deploy is still pending", async () => {
    let proved = false;
    server.use(
      http.get("https://cp.test/projects/hello", () =>
        HttpResponse.json({
          id: "p1",
          slug: "hello",
          productionDeploymentId: "dep-old",
        }),
      ),
      http.get("https://cp.test/projects/hello/deployments", () =>
        HttpResponse.json([
          { id: "dep-new", status: "building", version: 3, url: null },
          {
            id: "dep-old",
            status: "active",
            version: 2,
            url: "https://hello.bycreek.test",
          },
        ]),
      ),
      http.get("https://hello.bycreek.test/", () => {
        proved = true;
        return HttpResponse.html("<html><head><title>stale</title></head></html>");
      }),
    );
    const get = registerAndCapture(new Headers({ "x-api-key": "ck_live_test" })).get("get_status")!;
    const result = await get({ projectSlug: "hello" });
    const payload = JSON.parse(result.content[0].text);
    expect(proved).toBe(false);
    expect(payload).toMatchObject({
      ok: true,
      live: false,
      pending: true,
      productionUrl: "https://hello.bycreek.test",
      proof: null,
      latestDeployment: { id: "dep-new", status: "building", version: 3 },
    });
    expect(payload.nextStep).toContain("get_status");
  });

  it("get_status marks verify_failed when live production is not reachable", async () => {
    server.use(
      http.get("https://cp.test/projects/hello", () =>
        HttpResponse.json({
          id: "p1",
          slug: "hello",
          productionDeploymentId: "dep-new",
        }),
      ),
      http.get("https://cp.test/projects/hello/deployments", () =>
        HttpResponse.json([
          {
            id: "dep-new",
            status: "active",
            version: 2,
            url: "https://hello.bycreek.test",
          },
        ]),
      ),
      http.get("https://hello.bycreek.test/", () => new HttpResponse("nope", { status: 502 })),
    );
    const get = registerAndCapture(new Headers({ "x-api-key": "ck_live_test" })).get("get_status")!;
    const result = await get({ projectSlug: "hello" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: false,
      live: true,
      error: "verify_failed",
      proof: { ok: false, status: 502 },
    });
  });

  it("get_status points at get_build_log when the latest deploy failed", async () => {
    server.use(
      http.get("https://cp.test/projects/hello", () =>
        HttpResponse.json({
          id: "p1",
          slug: "hello",
          productionDeploymentId: "dep-old",
        }),
      ),
      http.get("https://cp.test/projects/hello/deployments", () =>
        HttpResponse.json([
          { id: "dep-new", status: "failed", version: 3, url: null },
          {
            id: "dep-old",
            status: "active",
            version: 2,
            url: "https://hello.bycreek.test",
          },
        ]),
      ),
    );
    const get = registerAndCapture(new Headers({ "x-api-key": "ck_live_test" })).get("get_status")!;
    const payload = JSON.parse((await get({ projectSlug: "hello" })).content[0].text);
    expect(payload).toMatchObject({
      ok: true,
      live: false,
      pending: false,
      proof: null,
      latestDeployment: { id: "dep-new", status: "failed" },
    });
    expect(payload.nextStep).toContain("get_build_log");
  });

  it.each([403, 500])("get_status returns an error when deployments GET is %s", async (status) => {
    server.use(
      http.get("https://cp.test/projects/hello", () =>
        HttpResponse.json({
          id: "p1",
          slug: "hello",
          framework: "vite-react",
        }),
      ),
      http.get("https://cp.test/projects/hello/deployments", () =>
        HttpResponse.json({ error: "api_error", message: "deployments lookup failed" }, { status }),
      ),
    );
    const get = registerAndCapture(new Headers({ "x-api-key": "ck_live_test" })).get("get_status")!;
    const result = await get({ projectSlug: "hello" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload).not.toMatchObject({ ok: true, latestDeployment: null });
    expect(payload.latestDeployment).toBeUndefined();
  });

  it("env_ls returns keys only and env_set does not echo the value", async () => {
    let posted: unknown;
    server.use(
      http.get("https://cp.test/projects/hello/env", () =>
        HttpResponse.json([{ key: "DATABASE_URL", value: "DATA****" }]),
      ),
      http.post("https://cp.test/projects/hello/env", async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ ok: true, key: "API_TOKEN" });
      }),
    );
    const headers = new Headers({ authorization: "Bearer ck_live_test" });
    const tools = registerAndCapture(headers);
    const ls = await tools.get("env_ls")!({ projectSlug: "hello" });
    const lsPayload = JSON.parse(ls.content[0].text);
    expect(lsPayload).toMatchObject({
      ok: true,
      project: "hello",
      keys: ["DATABASE_URL"],
    });
    expect(lsPayload).not.toHaveProperty("vars");
    expect(JSON.stringify(lsPayload)).not.toContain("DATA****");
    expect(JSON.stringify(lsPayload)).not.toContain("value");
    const set = await tools.get("env_set")!({
      projectSlug: "hello",
      key: "API_TOKEN",
      value: "super-secret",
    });
    const payload = JSON.parse(set.content[0].text);
    expect(posted).toEqual({ key: "API_TOKEN", value: "super-secret" });
    expect(payload).toMatchObject({
      ok: true,
      key: "API_TOKEN",
      pendingDeploy: true,
    });
    expect(payload.nextStep).toContain("deploy_prod");
    expect(JSON.stringify(payload)).not.toContain("super-secret");
  });

  it("deploy_prod POSTs /github/deploy-latest and does not wait", async () => {
    let posted: unknown;
    server.use(
      http.post("https://cp.test/github/deploy-latest", async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ ok: true, commitSha: "abc1234deadbeef", branch: "main" });
      }),
    );
    const deploy = registerAndCapture(new Headers({ authorization: "Bearer ck_live_test" })).get(
      "deploy_prod",
    )!;
    const result = await deploy({ projectSlug: "hello" });
    expect(posted).toEqual({ projectId: "hello" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      ok: true,
      triggered: true,
      pending: true,
      branch: "main",
      commitSha: "abc1234deadbeef",
    });
    expect(payload.nextStep).toContain("get_status");
    expect(payload.nextStep).toContain("proof.ok");
  });

  it("list_deployments returns a slim list", async () => {
    server.use(
      http.get("https://cp.test/projects/hello/deployments", () =>
        HttpResponse.json([
          {
            id: "d2",
            version: 2,
            status: "active",
            branch: "main",
            triggerType: "cli",
            createdAt: 200,
            url: "https://hello.bycreek.test",
          },
          {
            id: "d1",
            version: 1,
            status: "active",
            branch: "main",
            triggerType: "rollback",
            createdAt: 100,
            url: "https://hello-d1abcdef-team.bycreek.test",
          },
        ]),
      ),
    );
    const list = registerAndCapture(new Headers({ authorization: "Bearer ck_live_test" })).get(
      "list_deployments",
    )!;
    const result = await list({ projectSlug: "hello" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.deployments).toHaveLength(2);
    expect(payload.deployments[0]).toMatchObject({
      id: "d2",
      version: 2,
      status: "active",
      triggerType: "cli",
      url: "https://hello.bycreek.test",
    });
    expect(payload.deployments[1]).toMatchObject({
      id: "d1",
      triggerType: "rollback",
      url: "https://hello-d1abcdef-team.bycreek.test",
    });
  });

  it("rollback POSTs the required deploymentId even if other fields are empty", async () => {
    let posted: unknown;
    server.use(
      http.post("https://cp.test/projects/hello/rollback", async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({
          ok: true,
          deploymentId: "rb-1",
          rolledBackTo: "d1",
          url: "https://hello.bycreek.com",
        });
      }),
    );
    const rb = registerAndCapture(new Headers({ authorization: "Bearer ck_live_test" })).get(
      "rollback",
    )!;
    const result = await rb({ projectSlug: "hello", deploymentId: "d1" });
    expect(posted).toEqual({ deploymentId: "d1" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: true,
      rolledBackTo: "d1",
    });
  });

  it("rollback rejects an empty deploymentId without calling the control plane", async () => {
    let posted = false;
    server.use(
      http.post("https://cp.test/projects/hello/rollback", () => {
        posted = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const rb = registerAndCapture(new Headers({ authorization: "Bearer ck_live_test" })).get(
      "rollback",
    )!;
    const result = await rb({ projectSlug: "hello", deploymentId: "   " });
    expect(posted).toBe(false);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: false,
      error: "deployment_id_required",
    });
  });

  it("env_rm DELETEs the key", async () => {
    let deleted = false;
    server.use(
      http.delete("https://cp.test/projects/hello/env/API_TOKEN", () => {
        deleted = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const rm = registerAndCapture(new Headers({ authorization: "Bearer ck_live_test" })).get(
      "env_rm",
    )!;
    const result = await rm({ projectSlug: "hello", key: "API_TOKEN" });
    expect(deleted).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: true,
      key: "API_TOKEN",
      pendingDeploy: true,
    });
  });
});
