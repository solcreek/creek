import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { statusCommand } from "./status.js";
import { opsCommand } from "./ops.js";
import { claimCommand } from "./claim.js";

// Drive the citty commands' .run() directly with MSW mocking their HTTP and
// process.exit stubbed so assertions fire on the exit code + JSON output
// instead of tearing down vitest. Tests run non-TTY, so resolveJsonMode is
// true and the commands emit machine-readable JSON via jsonOutput. Fabricated
// IDs only.
const SBX = "https://sandbox.test";
const API = "https://cp.test";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}

let stdout: string;
beforeEach(() => {
  stdout = "";
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  });
  process.env.CREEK_SANDBOX_API_URL = SBX;
  process.env.CREEK_API_URL = API;
  // Empty (not deleted): getToken() falls back to the real ~/.creek/config.json
  // otherwise, which would leak the developer's token into tests. "" is falsy
  // → treated as unauthenticated; tests that need auth set a real value.
  process.env.CREEK_TOKEN = "";
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CREEK_SANDBOX_API_URL;
  delete process.env.CREEK_API_URL;
  delete process.env.CREEK_TOKEN;
});

/** Run a command and return the exit code its process.exit was called with. */
async function runExit(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    throw new Error("expected the command to call process.exit");
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}
function json() {
  return JSON.parse(stdout);
}

describe("creek status <id> (sandbox)", () => {
  it("prints the sandbox status as JSON and exits 0", async () => {
    server.use(
      http.get(`${SBX}/api/sandbox/sb-1/status`, () =>
        HttpResponse.json({ sandboxId: "sb-1", status: "active", previewUrl: "https://sb-1.test", claimable: true, expiresInSeconds: 3600 }),
      ),
    );
    const code = await runExit(statusCommand.run!({ args: { id: "sb-1" } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, type: "sandbox", status: "active", sandboxId: "sb-1" });
  });

  it("exits 1 with a not_found error when the sandbox is gone", async () => {
    server.use(http.get(`${SBX}/api/sandbox/gone/status`, () => new HttpResponse(null, { status: 404 })));
    const code = await runExit(statusCommand.run!({ args: { id: "gone" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("creek ops deployments", () => {
  it("lists deployments with the auth token and exits 0", async () => {
    process.env.CREEK_TOKEN = "tok-abc";
    let auth = "";
    server.use(
      http.get(`${API}/web-deploy/list`, ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        return HttpResponse.json([
          { environment: "sandbox", buildId: "b1" },
          { environment: "production", buildId: "b2" },
        ]);
      }),
    );
    const code = await runExit(opsCommand.run!({ args: { sub: "deployments" } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, count: 2 });
    expect(auth).toBe("Bearer tok-abc");
  });

  it("filters by environment", async () => {
    process.env.CREEK_TOKEN = "tok-abc";
    server.use(
      http.get(`${API}/web-deploy/list`, () =>
        HttpResponse.json([
          { environment: "sandbox", buildId: "b1" },
          { environment: "production", buildId: "b2" },
        ]),
      ),
    );
    const code = await runExit(opsCommand.run!({ args: { sub: "deployments", env: "production" } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, count: 1 });
  });
});

describe("creek claim <id>", () => {
  it("exits 1 (not_authenticated) without a token", async () => {
    const code = await runExit(claimCommand.run!({ args: { sandboxId: "sb-1" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_authenticated" });
  });

  it("exits 1 (not_claimable) for an expired sandbox", async () => {
    process.env.CREEK_TOKEN = "tok";
    server.use(
      http.get(`${SBX}/api/sandbox/sb-old/status`, () =>
        HttpResponse.json({ sandboxId: "sb-old", status: "expired", claimable: false, framework: null, templateId: null }),
      ),
    );
    const code = await runExit(claimCommand.run!({ args: { sandboxId: "sb-old" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_claimable", status: "expired" });
  });
});
