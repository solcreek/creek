import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whoamiCommand } from "./whoami.js";
import { loginCommand } from "./login.js";
import { logoutCommand } from "./logout.js";

// whoami / login / logout / keys driven through .run() with MSW standing in
// for the control-plane and HOME pointed at a temp dir, so ~/.creek is the
// test's own. Tests run non-TTY: JSON mode. Fabricated ids only.
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
let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  stdout = "";
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  });
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "creek-auth-keys-test-"));
  process.env.HOME = home;
  process.env.CREEK_API_URL = API;
  delete process.env.CREEK_TOKEN;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  delete process.env.CREEK_API_URL;
  delete process.env.CREEK_TOKEN;
});

async function runExit(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    throw new Error("expected the command to call process.exit");
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}
const json = () => JSON.parse(stdout);
const run = (cmd: { run?: unknown }, args: Record<string, unknown>) =>
  // async: a run() that exits synchronously still rejects the promise.
  runExit((async () => (cmd.run as (ctx: { args: unknown }) => unknown)({ args }))());

const configPath = () => join(home, ".creek", "config.json");
function saveConfig(config: Record<string, unknown>) {
  mkdirSync(join(home, ".creek"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config));
}
const readConfig = () => JSON.parse(readFileSync(configPath(), "utf8"));

const SESSION = { user: { id: "u1", name: "Owner", email: "owner@example.com" } };
const SCOPED = {
  id: "key-scoped",
  name: "agent",
  start: "creek_ab",
  prefix: null,
  legacy: false,
  team: { id: "org-1", slug: "acme" },
  scopes: ["env:read", "env:write", "project:read"],
  role: "member",
  effectiveScopes: ["env:read", "project:read"],
  access: "scoped",
  enabled: true,
  expiresAt: "2027-01-01T00:00:00.000Z",
  expired: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastUsedAt: "2026-10-14T00:00:00.000Z",
};
const LEGACY = {
  ...SCOPED,
  id: "key-legacy",
  name: null,
  legacy: true,
  team: null,
  scopes: null,
  role: null,
  effectiveScopes: null,
  access: "full",
  expiresAt: null,
  lastUsedAt: null,
  warning: "This is a legacy API key: …",
};

/** The API, answering for the keys it knows; records which key each call used. */
function api(keys: Record<string, unknown>, calls: string[] = []) {
  const known = (request: Request) => {
    const key = request.headers.get("x-api-key") ?? "";
    return key in keys ? key : null;
  };
  server.use(
    http.get(`${API}/api/auth/get-session`, ({ request }) =>
      known(request) ? HttpResponse.json(SESSION) : HttpResponse.json(null, { status: 401 }),
    ),
    http.get(`${API}/api-keys/self`, ({ request }) => {
      const key = known(request);
      calls.push(`GET self ${key}`);
      return key
        ? HttpResponse.json(keys[key] as Record<string, unknown>)
        : HttpResponse.json({ error: "unauthorized" }, { status: 401 });
    }),
    http.delete(`${API}/api-keys/self`, ({ request }) => {
      const key = known(request);
      calls.push(`DELETE self ${key}`);
      if (!key) return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      const id = (keys[key] as { id: string }).id;
      delete keys[key];
      return HttpResponse.json({ revoked: true, id });
    }),
  );
  return calls;
}

describe("creek whoami — the key in use", () => {
  it("reports a stored scoped key: source, kind, team, effective scopes, expiry, last use", async () => {
    saveConfig({ token: "tok-scoped" });
    api({ "tok-scoped": SCOPED });
    expect(await run(whoamiCommand, {})).toBe(0);
    const out = json();
    expect(out).toMatchObject({
      ok: true,
      email: "owner@example.com",
      tokenSource: "config",
      key: {
        id: "key-scoped",
        name: "agent",
        kind: "scoped",
        team: { id: "org-1", slug: "acme" },
        scopes: ["env:read", "env:write", "project:read"],
        effectiveScopes: ["env:read", "project:read"],
        expiresAt: "2027-01-01T00:00:00.000Z",
        lastUsedAt: "2026-10-14T00:00:00.000Z",
      },
    });
    expect(out.warning).toBeUndefined();
  });

  it("names CREEK_TOKEN as the source and warns when it overrides a stored key", async () => {
    saveConfig({ token: "tok-scoped" });
    process.env.CREEK_TOKEN = "tok-legacy";
    api({ "tok-scoped": SCOPED, "tok-legacy": LEGACY });
    expect(await run(whoamiCommand, {})).toBe(0);
    const out = json();
    expect(out).toMatchObject({
      tokenSource: "env:CREEK_TOKEN",
      key: { id: "key-legacy", kind: "legacy", team: null, effectiveScopes: null, access: "full" },
    });
    expect(out.key.warning).toContain("legacy");
    expect(out.warning).toContain("CREEK_TOKEN is set");
  });

  it("still succeeds against an API without /api-keys/self", async () => {
    process.env.CREEK_TOKEN = "tok";
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () => new HttpResponse("404 Not Found", { status: 404 })),
    );
    expect(await run(whoamiCommand, {})).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      authenticated: true,
      tokenSource: "env:CREEK_TOKEN",
      key: null,
      keyLookup: { error: "server_unsupported" },
    });
  });

  it("still succeeds when the key lookup fails for another reason", async () => {
    process.env.CREEK_TOKEN = "tok";
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () =>
        HttpResponse.json({ error: "internal", message: "boom" }, { status: 500 }),
      ),
    );
    expect(await run(whoamiCommand, {})).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      key: null,
      keyLookup: { error: "lookup_failed", status: 500 },
    });
  });

  it("an empty CREEK_TOKEN hides the stored key, and says so", async () => {
    saveConfig({ token: "tok-scoped" });
    process.env.CREEK_TOKEN = "";
    expect(await run(whoamiCommand, {})).toBe(1);
    expect(json()).toMatchObject({
      error: "not_authenticated",
      tokenSource: "env:CREEK_TOKEN",
      warning: expect.stringContaining("empty"),
    });
  });

  it("a refused CREEK_TOKEN key is blamed on CREEK_TOKEN, not on the saved login", async () => {
    process.env.CREEK_TOKEN = "dead";
    api({});
    expect(await run(whoamiCommand, {})).toBe(1);
    const out = json();
    expect(out).toMatchObject({ error: "session_expired", tokenSource: "env:CREEK_TOKEN" });
    expect(out.message).toContain("CREEK_TOKEN");
  });
});

describe("creek login --token", () => {
  it("warns that CREEK_TOKEN keeps winning over the key it saves", async () => {
    process.env.CREEK_TOKEN = "tok-legacy";
    api({ "tok-scoped": SCOPED, "tok-legacy": LEGACY });
    expect(await run(loginCommand, { token: "tok-scoped", json: true })).toBe(0);
    const out = json();
    expect(out).toMatchObject({ ok: true, saved: true, tokenSource: "env:CREEK_TOKEN" });
    expect(out.warning).toContain("overrides the key saved by `creek login`");
    expect(out.breadcrumbs[0].command).toBe("unset CREEK_TOKEN");
    expect(readConfig().token).toBe("tok-scoped");
  });

  it("does not warn without CREEK_TOKEN", async () => {
    api({ "tok-scoped": SCOPED });
    expect(await run(loginCommand, { token: "tok-scoped", json: true })).toBe(0);
    const out = json();
    expect(out).toMatchObject({ ok: true, tokenSource: "config" });
    expect(out.warning).toBeUndefined();
  });
});

describe("creek logout", () => {
  it("without --revoke forgets the saved key, keeps apiUrl, and says the key is still valid", async () => {
    saveConfig({ token: "tok-scoped", apiUrl: "https://elsewhere.test" });
    // No handlers: plain logout makes no request.
    expect(await run(logoutCommand, {})).toBe(0);
    const out = json();
    expect(out).toMatchObject({
      ok: true,
      loggedOut: true,
      configCleared: true,
      tokenSource: "config",
      revoked: false,
      reason: "not_requested",
      keyStillValid: true,
    });
    expect(out.breadcrumbs.map((b: { command: string }) => b.command)).toContain(
      "creek logout --revoke --json",
    );
    expect(readConfig()).toEqual({ apiUrl: "https://elsewhere.test" });
  });

  it("--revoke revokes the key on the server, then forgets it", async () => {
    saveConfig({ token: "tok-scoped" });
    const calls = api({ "tok-scoped": SCOPED });
    expect(await run(logoutCommand, { revoke: true })).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      revoked: true,
      keyId: "key-scoped",
      configCleared: true,
    });
    expect(calls).toEqual(["DELETE self tok-scoped"]);
    expect(readConfig().token).toBeUndefined();
  });

  it("--revoke is idempotent: a key the API already refuses still clears local state", async () => {
    saveConfig({ token: "tok-gone" });
    api({});
    expect(await run(logoutCommand, { revoke: true })).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      revoked: false,
      reason: "already_invalid",
      configCleared: true,
    });
    expect(readConfig().token).toBeUndefined();
  });

  it("--revoke against an API without the endpoint fails and keeps the saved key", async () => {
    saveConfig({ token: "tok-scoped" });
    server.use(
      http.delete(`${API}/api-keys/self`, () => new HttpResponse("404 Not Found", { status: 404 })),
    );
    expect(await run(logoutCommand, { revoke: true })).toBe(1);
    expect(json()).toMatchObject({
      ok: false,
      error: "server_unsupported",
      revoked: false,
      keyStillValid: true,
      configCleared: false,
    });
    expect(readConfig().token).toBe("tok-scoped");
  });

  it("--revoke with CREEK_TOKEN revokes that key and warns that the variable still holds it", async () => {
    saveConfig({ token: "tok-scoped" });
    process.env.CREEK_TOKEN = "tok-legacy";
    const calls = api({ "tok-scoped": SCOPED, "tok-legacy": LEGACY });
    expect(await run(logoutCommand, { revoke: true })).toBe(0);
    const out = json();
    expect(out).toMatchObject({
      revoked: true,
      keyId: "key-legacy",
      tokenSource: "env:CREEK_TOKEN",
      configCleared: true,
      savedKeyStillValid: true,
    });
    expect(out.warning).toContain("CREEK_TOKEN is still set");
    expect(calls).toEqual(["DELETE self tok-legacy"]);
  });

  it("--revoke with no key at all succeeds without a request", async () => {
    expect(await run(logoutCommand, { revoke: true })).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      revoked: false,
      reason: "no_key",
      configCleared: false,
    });
    expect(existsSync(configPath())).toBe(false);
  });
});
