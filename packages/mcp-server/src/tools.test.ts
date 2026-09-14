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
});
