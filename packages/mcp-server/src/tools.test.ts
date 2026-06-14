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

function registerAndCapture(): Map<string, Handler> {
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
    );

    const deploy = registerAndCapture().get("deploy")!;
    const result = await deploy({ files: { "index.html": "<h1>hi</h1>" } });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.url).toBe("https://sb-1.creeksandbox.test");
    expect(payload.sandboxId).toBe("sb-1");
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
});

describe("MCP deploy_status tool", () => {
  it("reads a sandbox's status", async () => {
    server.use(
      http.get(`${SANDBOX}/api/sandbox/abc123/status`, () =>
        HttpResponse.json({ status: "active", sandboxId: "abc123", previewUrl: "https://abc123.creeksandbox.test" }),
      ),
    );
    const status = registerAndCapture().get("deploy_status")!;
    const result = await status({ sandboxId: "abc123" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("abc123");
  });
});
