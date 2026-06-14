import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { sandboxDeploy, pollSandboxStatus, expiresInMinutes } from "./sandbox";

// MSW mocks the sandbox API so we can assert the request the CLI sends
// (body, ToS + agent headers) and how it handles deploy/poll responses —
// without the network. All values are fabricated.
const API = "https://sandbox-api.test";
const DEPLOY = `${API}/api/sandbox/deploy`;
const STATUS = `${API}/api/sandbox/status/abc`;

let lastRequest: { body: unknown; headers: Record<string, string> } | null = null;

const server = setupServer();
beforeAll(() => {
  process.env.CREEK_SANDBOX_API_URL = API;
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  lastRequest = null;
  server.resetHandlers();
});
afterAll(() => {
  delete process.env.CREEK_SANDBOX_API_URL;
  server.close();
});

const bundle = {
  manifest: { assets: ["/a.js"], hasWorker: true, entrypoint: "worker.js", renderMode: "ssr" },
  assets: { "a.js": "deadbeef" },
  source: "cli",
  framework: "nextjs",
};

describe("sandboxDeploy", () => {
  it("POSTs the bundle and returns the parsed response", async () => {
    server.use(
      http.post(DEPLOY, async ({ request }) => {
        lastRequest = {
          body: await request.json(),
          headers: Object.fromEntries(request.headers),
        };
        return HttpResponse.json({
          sandboxId: "sb-1",
          status: "deploying",
          statusUrl: STATUS,
          previewUrl: "https://sb-1.creeksandbox.test",
          expiresAt: "2026-06-14T12:00:00Z",
        });
      }),
    );
    const res = await sandboxDeploy(bundle);
    expect(res.sandboxId).toBe("sb-1");
    expect(lastRequest?.body).toEqual(bundle);
    expect(lastRequest?.headers["content-type"]).toContain("application/json");
  });

  it("attaches ToS and agent-token headers when provided", async () => {
    server.use(
      http.post(DEPLOY, async ({ request }) => {
        lastRequest = { body: null, headers: Object.fromEntries(request.headers) };
        return HttpResponse.json({ sandboxId: "sb-2", status: "deploying", statusUrl: STATUS, previewUrl: "x", expiresAt: "x" });
      }),
    );
    await sandboxDeploy(bundle, {
      tos: { version: "2026-06-01", acceptedAt: "2026-06-14T00:00:00Z" },
      agentToken: "agent-xyz",
    });
    expect(lastRequest?.headers["x-creek-tos-version"]).toBe("2026-06-01");
    expect(lastRequest?.headers["x-creek-tos-accepted-at"]).toBe("2026-06-14T00:00:00Z");
    expect(lastRequest?.headers["authorization"]).toBe("Bearer agent-xyz");
  });

  it("throws the API's error message on a non-ok response", async () => {
    server.use(
      http.post(DEPLOY, () =>
        HttpResponse.json({ message: "rate limited, slow down" }, { status: 429 }),
      ),
    );
    await expect(sandboxDeploy(bundle)).rejects.toThrow("rate limited, slow down");
  });

  it("falls back to a generic message when the error body isn't JSON", async () => {
    server.use(
      http.post(DEPLOY, () => new HttpResponse("nope", { status: 500, statusText: "Internal Server Error" })),
    );
    await expect(sandboxDeploy(bundle)).rejects.toThrow(/Internal Server Error|Sandbox deploy failed/);
  });
});

describe("pollSandboxStatus", () => {
  it("returns once the sandbox is active", async () => {
    server.use(
      http.get(STATUS, () =>
        HttpResponse.json({
          sandboxId: "sb-1",
          status: "active",
          previewUrl: "https://sb-1.creeksandbox.test",
          expiresAt: "2026-06-14T12:00:00Z",
          expiresInSeconds: 3600,
          claimable: true,
        }),
      ),
    );
    const s = await pollSandboxStatus(STATUS);
    expect(s.status).toBe("active");
    expect(s.previewUrl).toBe("https://sb-1.creeksandbox.test");
  });

  it("throws with the failed step + message when the deploy fails", async () => {
    server.use(
      http.get(STATUS, () =>
        HttpResponse.json({
          sandboxId: "sb-1",
          status: "failed",
          previewUrl: "",
          expiresAt: "",
          expiresInSeconds: 0,
          claimable: false,
          failedStep: "deploying",
          errorMessage: "No such module node:http",
        }),
      ),
    );
    await expect(pollSandboxStatus(STATUS)).rejects.toThrow("failed at deploying: No such module node:http");
  });

  it("throws on a non-ok status response", async () => {
    server.use(http.get(STATUS, () => new HttpResponse(null, { status: 503 })));
    await expect(pollSandboxStatus(STATUS)).rejects.toThrow("Status check failed (503)");
  });
});

describe("expiresInMinutes", () => {
  it("ceils remaining minutes and clamps past timestamps to 0", () => {
    const future = new Date(Date.now() + 90_000).toISOString(); // 1.5 min
    expect(expiresInMinutes(future)).toBe(2);
    expect(expiresInMinutes("2000-01-01T00:00:00Z")).toBe(0);
  });
});
