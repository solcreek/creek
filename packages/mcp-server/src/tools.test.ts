import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { registerTools, type ToolContext } from "./tools.js";
import type { Env } from "./types.js";

// MSW mocks the sandbox API so we can drive the MCP tool handlers (which the
// agent calls) without the network. We capture the registered handlers with
// a fake McpServer rather than standing up the full MCP transport.
const SANDBOX = "https://sandbox.test";

type Handler = (args: any) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function registerAndCapture(
  headers: Headers = new Headers(),
  timing: ToolContext["timing"] = {},
): Map<string, Handler> {
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
    // Short polling budgets so timeouts resolve in milliseconds.
    timing: { sandboxMaxWaitMs: 200, pollIntervalMs: 10, ...timing },
  };
  registerTools(fakeServer as never, ctx);
  return handlers;
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
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
    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: false,
      error: "api_error",
      message: "rate limited",
      status: 429,
    });
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
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("verify_failed");
    expect(payload.proof.ok).toBe(false);
    // Envelope: a failure carries its own message, never the success one.
    expect(payload.message).not.toBe("Demo deployed successfully.");
    expect(payload.message).toContain("sb-demo-fail");
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
    // Envelope: the array is wrapped as `resources` (was a bare array).
    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      resources: [{ id: "r1", kind: "database", name: "db" }],
    });
  });

  it("passes the API's error code, status and fields through to the agent", async () => {
    server.use(
      http.get("https://cp.test/resources", () =>
        HttpResponse.json(
          {
            error: "insufficient_scope",
            message: "This API key lacks the scope: resource:read",
            required: ["resource:read"],
            granted: ["deploy:preview"],
          },
          { status: 403 },
        ),
      ),
    );
    const list = registerAndCapture(new Headers({ authorization: "Bearer ck_live_test" })).get(
      "list_resources",
    )!;
    const result = await list({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: false,
      error: "insufficient_scope",
      message: "This API key lacks the scope: resource:read",
      status: 403,
      details: { required: ["resource:read"], granted: ["deploy:preview"] },
    });
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

  it("get_status includes latest deployment", async () => {
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
          { id: "dep-new", status: "active", version: 2, createdAt: 200 },
          { id: "dep-old", status: "active", version: 1, createdAt: 100 },
        ]),
      ),
    );
    const get = registerAndCapture(new Headers({ "x-api-key": "ck_live_test" })).get("get_status")!;
    const result = await get({ projectSlug: "hello" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: true,
      slug: "hello",
      productionDeploymentId: "dep-new",
      latestDeployment: { id: "dep-new", status: "active", version: 2 },
    });
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
    // Key and target only; a server without targets means "all".
    expect(lsPayload.vars).toEqual([{ key: "DATABASE_URL", target: "all" }]);
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

  it("env_set / env_rm pass a target, and env_set refuses a server that ignored it", async () => {
    let posted: unknown;
    let deleted = "";
    let echoTarget: string | undefined = "production";
    let listedRows: Record<string, unknown>[] = [
      { key: "STRIPE_KEY", target: "preview", value: "STRI****" },
    ];
    server.use(
      http.post("https://cp.test/projects/hello/env", async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ ok: true, key: "STRIPE_KEY", target: echoTarget });
      }),
      http.get("https://cp.test/projects/hello/env", () => HttpResponse.json(listedRows)),
      http.delete("https://cp.test/projects/hello/env/STRIPE_KEY", ({ request }) => {
        deleted = request.url;
        return HttpResponse.json({ ok: true, removed: 1 });
      }),
    );
    const tools = registerAndCapture(new Headers({ authorization: "Bearer ck_live_test" }));
    const args = {
      projectSlug: "hello",
      key: "STRIPE_KEY",
      value: "sk_live",
      target: "production",
    };

    const ok = JSON.parse((await tools.get("env_set")!(args)).content[0].text);
    expect(posted).toEqual({ key: "STRIPE_KEY", value: "sk_live", target: "production" });
    expect(ok).toMatchObject({ ok: true, target: "production" });

    echoTarget = undefined; // a server without targets stored it for all deploys
    const refused = await tools.get("env_set")!(args);
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text)).toMatchObject({
      ok: false,
      error: "target_unsupported",
    });

    const rm = await tools.get("env_rm")!({
      projectSlug: "hello",
      key: "STRIPE_KEY",
      target: "preview",
    });
    expect(new URL(deleted).searchParams.get("target")).toBe("preview");
    expect(JSON.parse(rm.content[0].text)).toMatchObject({ ok: true, target: "preview" });

    // A server without targets lists no target field: env_rm refuses rather
    // than let it delete the all-deploys value.
    deleted = "";
    listedRows = [{ key: "STRIPE_KEY", value: "STRI****" }];
    const refusedRm = await tools.get("env_rm")!({
      projectSlug: "hello",
      key: "STRIPE_KEY",
      target: "production",
    });
    expect(refusedRm.isError).toBe(true);
    expect(JSON.parse(refusedRm.content[0].text)).toMatchObject({ error: "target_unsupported" });
    expect(deleted).toBe("");

    // A key that may delete but not list (env:write without env:read) still
    // removes the value: the list is only a guard against old servers.
    server.use(
      http.get("https://cp.test/projects/hello/env", () =>
        HttpResponse.json({ error: "insufficient_scope" }, { status: 403 }),
      ),
    );
    const writeOnly = await tools.get("env_rm")!({
      projectSlug: "hello",
      key: "STRIPE_KEY",
      target: "production",
    });
    expect(JSON.parse(writeOnly.content[0].text)).toMatchObject({ ok: true, target: "production" });
    expect(new URL(deleted).searchParams.get("target")).toBe("production");

    // Any other list failure stops before the delete.
    deleted = "";
    server.use(
      http.get("https://cp.test/projects/hello/env", () =>
        HttpResponse.json({ error: "internal" }, { status: 500 }),
      ),
    );
    const failedList = await tools.get("env_rm")!({
      projectSlug: "hello",
      key: "STRIPE_KEY",
      target: "production",
    });
    expect(failedList.isError).toBe(true);
    expect(deleted).toBe("");

    // For a preview value, the warning is about production, not previews.
    echoTarget = undefined;
    const previewSet = await tools.get("env_set")!({ ...args, target: "preview" });
    expect(JSON.parse(previewSet.content[0].text).message).toContain("production deploys now get");
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
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: true,
      triggered: true,
      pending: true,
      branch: "main",
      commitSha: "abc1234deadbeef",
    });
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
          },
          {
            id: "d1",
            version: 1,
            status: "active",
            branch: "main",
            triggerType: "rollback",
            createdAt: 100,
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
    });
    expect(payload.deployments[1]).toMatchObject({ id: "d1", triggerType: "rollback" });
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

// ----------------------------------------------------------------
// One result envelope for every tool
// ----------------------------------------------------------------

const AUTH = () => new Headers({ authorization: "Bearer ck_live_test" });
const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

/** A fetch rejection the way Node's undici reports an unreachable host. */
function fetchFailed(code?: string): TypeError {
  const err = new TypeError("fetch failed");
  if (code) (err as { cause?: unknown }).cause = { code };
  return err;
}

describe("MCP result envelope — sandbox tools", () => {
  it("deploy_status wraps the status in { ok: true }", async () => {
    server.use(
      http.get(`${SANDBOX}/api/sandbox/abc123/status`, () =>
        HttpResponse.json({ status: "active", sandboxId: "abc123", expiresInSeconds: 60 }),
      ),
    );
    const result = await registerAndCapture().get("deploy_status")!({ sandboxId: "abc123" });
    expect(parse(result)).toMatchObject({
      ok: true,
      sandboxId: "abc123",
      status: "active",
      expiresInSeconds: 60,
    });
  });

  it("deploy_status returns a JSON not_found error with the sandboxId", async () => {
    server.use(
      http.get(`${SANDBOX}/api/sandbox/gone/status`, () =>
        HttpResponse.json({ error: "not_found", message: "Sandbox not found" }, { status: 404 }),
      ),
    );
    const result = await registerAndCapture().get("deploy_status")!({ sandboxId: "gone" });
    expect(result.isError).toBe(true);
    expect(parse(result)).toEqual({
      ok: false,
      error: "not_found",
      message: "Sandbox not found",
      status: 404,
      sandboxId: "gone",
    });
  });

  it("deploy_delete returns { ok: true, deleted: true }", async () => {
    server.use(
      http.delete(`${SANDBOX}/api/sandbox/sb-9`, () =>
        HttpResponse.json({ ok: true, message: "Sandbox deleted" }),
      ),
    );
    const result = await registerAndCapture().get("deploy_delete")!({ sandboxId: "sb-9" });
    expect(result.isError).toBeUndefined();
    expect(parse(result)).toEqual({ ok: true, sandboxId: "sb-9", deleted: true });
  });

  it("deploy_delete forwards the client IP like deploy, so the creator check can match", async () => {
    let saw: Record<string, string> = {};
    server.use(
      http.delete(`${SANDBOX}/api/sandbox/sb-9`, ({ request }) => {
        saw = Object.fromEntries(request.headers);
        return HttpResponse.json({ ok: true });
      }),
    );
    await registerAndCapture().get("deploy_delete")!({ sandboxId: "sb-9" });
    expect(saw["x-forwarded-for"]).toBe("203.0.113.7");
    expect(saw["x-internal-secret"]).toBe("test-internal-secret");
  });

  it("deploy_delete keeps the API's error code", async () => {
    server.use(
      http.delete(`${SANDBOX}/api/sandbox/sb-9`, () =>
        HttpResponse.json(
          { error: "forbidden", message: "Only the sandbox creator can delete it" },
          { status: 403 },
        ),
      ),
    );
    const result = await registerAndCapture().get("deploy_delete")!({ sandboxId: "sb-9" });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({
      ok: false,
      error: "forbidden",
      status: 403,
      sandboxId: "sb-9",
    });
  });

  it("deploy reports an unreachable sandbox API as api_unreachable, not a throw", async () => {
    server.use(http.post(`${SANDBOX}/api/sandbox/deploy`, () => HttpResponse.error()));
    const result = await registerAndCapture().get("deploy")!({ files: { "a.txt": "x" } });
    expect(result.isError).toBe(true);
    // A POST that failed without a cause may have reached the server.
    expect(parse(result)).toMatchObject({
      ok: false,
      error: "api_unreachable",
      retryable: false,
      mayHaveApplied: true,
    });
  });
});

describe("MCP result envelope — authenticated tools", () => {
  it("a failed read (GET) is api_unreachable and retryable", async () => {
    server.use(http.get("https://cp.test/projects", () => HttpResponse.error()));
    const result = await registerAndCapture(AUTH()).get("list_projects")!({});
    expect(result.isError).toBe(true);
    const payload = parse(result);
    expect(payload).toMatchObject({ ok: false, error: "api_unreachable", retryable: true });
    expect(payload.message).toContain("control plane");
    expect(payload.mayHaveApplied).toBeUndefined();
  });

  it("a mutation that may have been sent is not retryable", async () => {
    server.use(http.post("https://cp.test/projects/hello/env", () => HttpResponse.error()));
    const result = await registerAndCapture(AUTH()).get("env_set")!({
      projectSlug: "hello",
      key: "A",
      value: "b",
    });
    expect(parse(result)).toMatchObject({
      ok: false,
      error: "api_unreachable",
      retryable: false,
      mayHaveApplied: true,
    });
  });

  it("a mutation refused at connect (ECONNREFUSED) is retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(fetchFailed("ECONNREFUSED"));
    const result = await registerAndCapture(AUTH()).get("create_resource")!({
      kind: "database",
      name: "db",
    });
    expect(parse(result)).toMatchObject({
      ok: false,
      error: "api_unreachable",
      retryable: true,
      reason: "ECONNREFUSED",
    });
  });

  it("a mutation whose response broke off is not retryable", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(body, { status: 200 }));
    const result = await registerAndCapture(AUTH()).get("delete_resource")!({ resourceId: "r1" });
    expect(parse(result)).toMatchObject({
      ok: false,
      error: "api_unreachable",
      retryable: false,
    });
  });

  it("create_resource and query_database answer { ok: true, ...data }", async () => {
    server.use(
      http.post("https://cp.test/resources", () =>
        HttpResponse.json({ id: "r1", kind: "database", name: "db" }, { status: 201 }),
      ),
      http.post("https://cp.test/resources/r1/query", () =>
        HttpResponse.json({ columns: ["n"], rows: [{ n: 1 }], meta: { changes: 0 } }),
      ),
    );
    const tools = registerAndCapture(AUTH());
    expect(parse(await tools.get("create_resource")!({ kind: "database", name: "db" }))).toEqual({
      ok: true,
      id: "r1",
      kind: "database",
      name: "db",
    });
    expect(
      parse(await tools.get("query_database")!({ resourceId: "r1", sql: "select 1 as n" })),
    ).toMatchObject({ ok: true, columns: ["n"], rows: [{ n: 1 }] });
  });

  it("attach / detach / rename / delete answer JSON, not prose", async () => {
    server.use(
      http.post("https://cp.test/projects/hello/bindings", () =>
        HttpResponse.json(
          { projectId: "p1", bindingName: "DB", resourceId: "r1" },
          { status: 201 },
        ),
      ),
      http.delete("https://cp.test/projects/hello/bindings/DB", () =>
        HttpResponse.json({ ok: true }),
      ),
      http.patch("https://cp.test/resources/r1", () =>
        HttpResponse.json({ id: "r1", name: "main", updatedAt: 5 }),
      ),
      http.delete("https://cp.test/resources/r1", () =>
        HttpResponse.json({ id: "r1", status: "deleted" }),
      ),
    );
    const tools = registerAndCapture(AUTH());
    expect(
      parse(
        await tools.get("attach_resource")!({
          projectSlug: "hello",
          resourceId: "r1",
          bindingName: "DB",
        }),
      ),
    ).toMatchObject({ ok: true, project: "hello", resourceId: "r1", bindingName: "DB" });
    expect(
      parse(await tools.get("detach_resource")!({ projectSlug: "hello", bindingName: "DB" })),
    ).toMatchObject({ ok: true, project: "hello", bindingName: "DB", detached: true });
    expect(parse(await tools.get("rename_resource")!({ resourceId: "r1", name: "main" }))).toEqual({
      ok: true,
      resourceId: "r1",
      name: "main",
      id: "r1",
      updatedAt: 5,
    });
    expect(parse(await tools.get("delete_resource")!({ resourceId: "r1" }))).toMatchObject({
      ok: true,
      resourceId: "r1",
      deleted: true,
    });
  });

  it("get_build_log: an unknown id prefix is a JSON not_found, a log is { ok: true }", async () => {
    server.use(
      http.get("https://cp.test/projects/hello/deployments", () =>
        HttpResponse.json([{ id: "11111111-2222-3333-4444-555555555555" }]),
      ),
      http.get(
        "https://cp.test/projects/hello/deployments/11111111-2222-3333-4444-555555555555/logs",
        () =>
          HttpResponse.json({
            entries: [{ ts: 1, step: "build", stream: "stderr", level: "error", msg: "boom" }],
            metadata: {
              deploymentId: "11111111-2222-3333-4444-555555555555",
              status: "failed",
              startedAt: 1,
              endedAt: 2,
              bytes: 4,
              lines: 1,
              truncated: false,
              errorCode: null,
              errorStep: "build",
              r2Key: "k",
            },
          }),
      ),
    );
    const log = registerAndCapture(AUTH()).get("get_build_log")!;
    const missing = await log({ projectSlug: "hello", deploymentId: "99999999" });
    expect(missing.isError).toBe(true);
    expect(parse(missing)).toMatchObject({ ok: false, error: "not_found" });

    const found = parse(await log({ projectSlug: "hello", deploymentId: "11111111" }));
    expect(found).toMatchObject({ ok: true, summary: { status: "failed", errorStep: "build" } });
    expect(found.importantLines).toHaveLength(1);
  });
});

describe("MCP sandbox deploy keeps the sandboxId on every outcome", () => {
  const created = (id: string) =>
    http.post(`${SANDBOX}/api/sandbox/deploy`, () =>
      HttpResponse.json(
        {
          sandboxId: id,
          status: "queued",
          statusUrl: `${SANDBOX}/api/sandbox/${id}/status`,
          previewUrl: `https://${id}.creeksandbox.test`,
        },
        { status: 202 },
      ),
    );

  it("a sandbox that never goes live is a timeout result with its id, not a throw", async () => {
    server.use(
      created("sb-slow"),
      http.get(`${SANDBOX}/api/sandbox/sb-slow/status`, () =>
        HttpResponse.json({ sandboxId: "sb-slow", status: "deploying" }),
      ),
    );
    const result = await registerAndCapture().get("deploy")!({ files: { "a.txt": "x" } });
    expect(result.isError).toBe(true);
    const payload = parse(result);
    expect(payload).toMatchObject({
      ok: false,
      error: "timeout",
      sandboxId: "sb-slow",
      url: "https://sb-slow.creeksandbox.test",
      sandboxStatus: "deploying",
      retryable: false,
    });
    expect(payload.nextStep).toContain("deploy_status");
  });

  it("a failed sandbox build is deploy_failed with its id and step", async () => {
    server.use(
      created("sb-bad"),
      http.get(`${SANDBOX}/api/sandbox/sb-bad/status`, () =>
        HttpResponse.json({
          sandboxId: "sb-bad",
          status: "failed",
          failedStep: "upload",
          errorMessage: "too big",
        }),
      ),
    );
    const result = await registerAndCapture().get("deploy_demo")!({});
    expect(parse(result)).toMatchObject({
      ok: false,
      error: "deploy_failed",
      sandboxId: "sb-bad",
      failedStep: "upload",
      errorMessage: "too big",
    });
  });

  it("an unreadable status after the sandbox was created is not retryable", async () => {
    server.use(
      created("sb-lost"),
      http.get(`${SANDBOX}/api/sandbox/sb-lost/status`, () => HttpResponse.error()),
    );
    const result = await registerAndCapture().get("deploy")!({ files: { "a.txt": "x" } });
    expect(parse(result)).toMatchObject({
      ok: false,
      error: "api_unreachable",
      sandboxId: "sb-lost",
      retryable: false,
      mayHaveApplied: true,
    });
  });
});
