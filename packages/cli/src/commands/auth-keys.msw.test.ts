import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import consola from "consola";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whoamiCommand } from "./whoami.js";
import { loginCommand } from "./login.js";
import { logoutCommand } from "./logout.js";
import { keysCommand } from "./keys.js";

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
const sub = (name: string) => (keysCommand.subCommands as Record<string, { run?: unknown }>)[name];

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
      keyPrefix: "tok-scoped",
      dashboardUrl: `${API}/api-keys`,
    });
    // The saved key is gone from here: only the dashboard can revoke it now,
    // so no breadcrumb points at a --revoke that has nothing left to revoke.
    expect(out.message).toContain(`dashboard: ${API}/api-keys`);
    expect(out.breadcrumbs.map((b: { command: string }) => b.command)).not.toContain(
      "creek logout --revoke --json",
    );
    expect(readConfig()).toEqual({ apiUrl: "https://elsewhere.test" });
  });

  it("without --revoke, a CREEK_TOKEN key is still revocable, so the breadcrumb stays", async () => {
    process.env.CREEK_TOKEN = "tok-legacy";
    expect(await run(logoutCommand, {})).toBe(0);
    const out = json();
    expect(out).toMatchObject({
      ok: true,
      tokenSource: "env:CREEK_TOKEN",
      configCleared: false,
      keyStillValid: true,
    });
    expect(out.dashboardUrl).toBeUndefined();
    expect(out.breadcrumbs.map((b: { command: string }) => b.command)).toContain(
      "creek logout --revoke --json",
    );
  });

  it("--revoke revokes the key on the server, then forgets it", async () => {
    saveConfig({ token: "tok-scoped" });
    const calls = api({ "tok-scoped": SCOPED });
    expect(await run(logoutCommand, { revoke: true })).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      revoked: true,
      configCleared: true,
      keys: [{ source: "config", keyPrefix: "tok-scoped", revoked: true, keyId: "key-scoped" }],
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
      configCleared: true,
      keys: [{ source: "config", revoked: false, reason: "already_invalid" }],
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
      keys: [{ source: "config", revoked: false, reason: "server_unsupported" }],
    });
    expect(readConfig().token).toBe("tok-scoped");
  });

  it("--revoke with CREEK_TOKEN and a different saved key revokes both, each with itself", async () => {
    saveConfig({ token: "tok-scoped" });
    process.env.CREEK_TOKEN = "tok-legacy";
    const calls = api({ "tok-scoped": SCOPED, "tok-legacy": LEGACY });
    const success = vi.spyOn(consola, "success").mockImplementation(() => {});
    expect(await run(logoutCommand, { revoke: true })).toBe(0);
    const out = json();
    expect(out).toMatchObject({
      ok: true,
      revoked: true,
      tokenSource: "env:CREEK_TOKEN",
      configCleared: true,
      keys: [
        { source: "env:CREEK_TOKEN", keyPrefix: "tok-legacy", revoked: true, keyId: "key-legacy" },
        { source: "config", keyPrefix: "tok-scoped", revoked: true, keyId: "key-scoped" },
      ],
    });
    expect(out.savedKeyStillValid).toBeUndefined();
    expect(out.warning).toContain("CREEK_TOKEN is still set");
    expect(calls).toEqual(["DELETE self tok-legacy", "DELETE self tok-scoped"]);
    expect(readConfig().token).toBeUndefined();
    // The human lines name each key's outcome.
    const lines = success.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("Revoked the CREEK_TOKEN key tok-legacy (id key-legacy).");
    expect(lines).toContain("Revoked the saved key tok-scoped (id key-scoped).");
  });

  it("--revoke keeps a saved key it could not revoke, and exits 1", async () => {
    saveConfig({ token: "tok-scoped" });
    process.env.CREEK_TOKEN = "tok-legacy";
    const calls = api({ "tok-legacy": LEGACY });
    // The saved key's revocation hits an outage.
    server.use(
      http.delete(`${API}/api-keys/self`, ({ request }) =>
        request.headers.get("x-api-key") === "tok-scoped"
          ? HttpResponse.json({ error: "unavailable", message: "Down" }, { status: 503 })
          : undefined,
      ),
    );
    const error = vi.spyOn(consola, "error").mockImplementation(() => {});
    expect(await run(logoutCommand, { revoke: true })).toBe(1);
    expect(json()).toMatchObject({
      ok: false,
      error: "revoke_failed",
      configCleared: false,
      keys: [
        { source: "env:CREEK_TOKEN", revoked: true },
        { source: "config", revoked: false, reason: "revoke_failed", status: 503 },
      ],
    });
    expect(calls).toEqual(["DELETE self tok-legacy"]);
    expect(readConfig().token).toBe("tok-scoped");
    expect(error.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining("Could not revoke the saved key tok-scoped"),
    );
  });

  it("--revoke with an empty CREEK_TOKEN still revokes the saved key", async () => {
    saveConfig({ token: "tok-scoped" });
    process.env.CREEK_TOKEN = "";
    const calls = api({ "tok-scoped": SCOPED });
    expect(await run(logoutCommand, { revoke: true })).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      revoked: true,
      configCleared: true,
      keys: [{ source: "config", revoked: true }],
    });
    expect(calls).toEqual(["DELETE self tok-scoped"]);
  });

  it("--revoke sends one request when CREEK_TOKEN and the saved key are the same key", async () => {
    saveConfig({ token: "tok-scoped" });
    process.env.CREEK_TOKEN = "tok-scoped";
    const calls = api({ "tok-scoped": SCOPED });
    expect(await run(logoutCommand, { revoke: true })).toBe(0);
    expect(json()).toMatchObject({
      configCleared: true,
      keys: [{ source: "env:CREEK_TOKEN+config", revoked: true }],
    });
    expect(calls).toEqual(["DELETE self tok-scoped"]);
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

describe("creek keys", () => {
  it("keys self shows the key in use", async () => {
    process.env.CREEK_TOKEN = "tok-scoped";
    api({ "tok-scoped": SCOPED });
    expect(await run(sub("self"), {})).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      tokenSource: "env:CREEK_TOKEN",
      key: { id: "key-scoped", kind: "scoped", effectiveScopes: ["env:read", "project:read"] },
    });
  });

  it("keys self against an older API says server_unsupported", async () => {
    process.env.CREEK_TOKEN = "tok";
    server.use(
      http.get(`${API}/api-keys/self`, () => new HttpResponse("404 Not Found", { status: 404 })),
    );
    expect(await run(sub("self"), {})).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "server_unsupported" });
  });

  it.each([
    ["ls", {}],
    ["create", { name: "ci", team: "acme", scopes: "read-only" }],
  ])("keys %s fails with session_required without calling the API", async (name, args) => {
    process.env.CREEK_TOKEN = "tok-scoped";
    // No handlers: any request would fail the test (onUnhandledRequest: error).
    expect(await run(sub(name), args)).toBe(1);
    const out = json();
    expect(out).toMatchObject({
      ok: false,
      error: "session_required",
      dashboardUrl: expect.stringContaining("/api-keys"),
    });
    expect(out.breadcrumbs.map((b: { command: string }) => b.command)).toContain(
      "creek keys self --json",
    );
  });

  it("keys revoke <id> needs the dashboard; keys revoke alone asks for --self", async () => {
    process.env.CREEK_TOKEN = "tok-scoped";
    expect(await run(sub("revoke"), { id: "key-other" })).toBe(1);
    expect(json().error).toBe("session_required");
    stdout = "";
    expect(await run(sub("revoke"), {})).toBe(1);
    expect(json().error).toBe("missing_target");
  });

  it("keys revoke --self revokes the key in use and leaves the saved config alone", async () => {
    saveConfig({ token: "tok-scoped" });
    const calls = api({ "tok-scoped": SCOPED });
    expect(await run(sub("revoke"), { self: true })).toBe(0);
    expect(json()).toMatchObject({ ok: true, revoked: true, keyId: "key-scoped" });
    expect(calls).toEqual(["DELETE self tok-scoped"]);
    expect(readConfig().token).toBe("tok-scoped");
    // A second revoke: the key is already gone.
    stdout = "";
    expect(await run(sub("revoke"), { self: true })).toBe(0);
    expect(json()).toMatchObject({ ok: true, revoked: false, reason: "already_invalid" });
  });

  it("keys revoke --self --dry-run revokes nothing", async () => {
    process.env.CREEK_TOKEN = "tok-scoped";
    const calls = api({ "tok-scoped": SCOPED });
    expect(await run(sub("revoke"), { self: true, "dry-run": true })).toBe(0);
    expect(json()).toMatchObject({ ok: true, mode: "dry-run", key: { id: "key-scoped" } });
    expect(calls).toEqual(["GET self tok-scoped"]);
  });
});
