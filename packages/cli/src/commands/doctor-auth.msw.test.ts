import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import consola from "consola";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreekClient } from "@solcreek/sdk";
import { doctorCommand } from "./doctor.js";
import { runAuthDoctor } from "../utils/doctor-auth.js";

const API = "https://cp.test";
const OTHER_API = "https://other.cp.test";

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
let workDir: string;
let prevHome: string | undefined;
let prevCwd: string;

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
  prevCwd = process.cwd();
  home = mkdtempSync(join(tmpdir(), "creek-doctor-auth-home-"));
  workDir = mkdtempSync(join(tmpdir(), "creek-doctor-auth-work-"));
  process.env.HOME = home;
  process.env.CREEK_API_URL = API;
  delete process.env.CREEK_TOKEN;
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(prevCwd);
  vi.restoreAllMocks();
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
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
const runDoctorCmd = (args: Record<string, unknown>) =>
  runExit((async () => (doctorCommand.run as (ctx: { args: unknown }) => unknown)({ args }))());

function saveConfig(config: Record<string, unknown>) {
  mkdirSync(join(home, ".creek"), { recursive: true });
  const full = "token" in config ? { tokenApiUrl: API, ...config } : config;
  writeFileSync(join(home, ".creek", "config.json"), JSON.stringify(full));
}

const TOKEN_CI = "crk_sk_live_CiDe7pL9mQx4Zv8Kn2Wr6Yt5B";
const TOKEN_LEGACY = "crk_sk_live_LeGa5hJ2cTf8Nq1wXs6dVk9M";
const TOKEN_RO = "crk_sk_live_ReAd3oNlY8vBm4Cx9Kz1Pq7S";
const TOKEN_DEMOTED = "crk_sk_live_DeMo2tEd7kWp5Nr8Qx3Jv6H";
const TOKEN_NO_READ = "crk_sk_live_NoRd4pLs9zXc2Vm6Bn8Kt1Q";
const TOKEN_UNUSABLE = "crk_sk_live_UnUs1aBl5eDf7Gh9Jk2Lm4N";

const SESSION = { user: { id: "u1", name: "Owner", email: "owner@example.com" } };

function makeKeySelf(overrides: Record<string, unknown>) {
  return {
    id: "key-1",
    name: "ci-key",
    start: "crk_sk_live_CiDe",
    prefix: null,
    legacy: false,
    team: { id: "org-1", slug: "acme" },
    scopes: ["project:read", "deploy:production", "deploy:preview", "logs:read"],
    role: "admin",
    effectiveScopes: ["project:read", "deploy:production", "deploy:preview", "logs:read"],
    access: "scoped",
    enabled: true,
    expiresAt: null,
    expired: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("creek doctor --auth", () => {
  it("fails with not_authenticated when no token is present", async () => {
    expect(await runDoctorCmd({ auth: true, json: true })).toBe(1);
    const out = json();
    expect(out).toMatchObject({
      ok: false,
      error: "not_authenticated",
      mode: "auth",
      tokenSource: null,
    });
    expect(out.checks.find((c: { id: string }) => c.id === "token")).toMatchObject({
      status: "fail",
      code: "not_authenticated",
    });
  });

  it("reports empty CREEK_TOKEN specifically instead of falling back to saved config", async () => {
    saveConfig({ token: TOKEN_CI });
    process.env.CREEK_TOKEN = "";

    expect(await runDoctorCmd({ auth: true, prod: true, json: true })).toBe(1);
    const out = json();
    expect(out).toMatchObject({
      ok: false,
      error: "not_authenticated",
      tokenSource: "env:CREEK_TOKEN",
    });
    expect(String(out.message)).toContain("CREEK_TOKEN is set but empty");
  });

  it("stops before network calls when the token contains a newline", async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/*`, () => {
        calls++;
        return HttpResponse.json(SESSION);
      }),
    );
    process.env.CREEK_TOKEN = "crk_sk_live_bad\nline";

    expect(await runDoctorCmd({ auth: true, json: true })).toBe(1);
    expect(calls).toBe(0);
    expect(json()).toMatchObject({
      ok: false,
      error: "invalid_token_format",
      tokenFormatIssue: "contains_newline",
      tokenSource: "env:CREEK_TOKEN",
    });
  });

  it("diagnoses wrapped-in-quotes CREEK_TOKEN without leaking the raw token", async () => {
    process.env.CREEK_TOKEN = '"crk_sk_live_secretQuotedValue123"';
    server.use(
      http.get(`${API}/api/auth/get-session`, () =>
        HttpResponse.json(
          { message: "Invalid API key.", code: "INVALID_API_KEY" },
          { status: 403 },
        ),
      ),
      http.get(`${API}/api-keys/self`, () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    expect(await runDoctorCmd({ auth: true, json: true })).toBe(1);
    const out = json();
    expect(out).toMatchObject({
      ok: false,
      error: "unauthorized",
      tokenSource: "env:CREEK_TOKEN",
      tokenFormatIssue: "wrapped_in_quotes",
    });
    expect(String(out.message)).toContain("CREEK_TOKEN");
    expect(String(out.message)).toContain("quotes");
    expect(stdout).not.toContain("secretQuotedValue123");
  });

  it("enforces saved-key API binding before sending any request", async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/*`, () => {
        calls++;
        return HttpResponse.json(SESSION);
      }),
    );
    saveConfig({ token: TOKEN_CI, tokenApiUrl: OTHER_API });

    expect(await runDoctorCmd({ auth: true, json: true })).toBe(1);
    expect(calls).toBe(0);
    expect(json()).toMatchObject({
      ok: false,
      error: "api_mismatch",
      savedKeyApiUrl: OTHER_API,
      apiUrl: API,
    });
  });

  it("reports non-JSON 403 HTML block as edge_blocked without suggesting creek login", async () => {
    process.env.CREEK_TOKEN = TOKEN_CI;
    server.use(
      http.get(
        `${API}/api/auth/get-session`,
        () =>
          new HttpResponse("<html>Attention Required!</html>", {
            status: 403,
            headers: {
              "content-type": "text/html",
              "cf-ray": "ray-999-DFW",
              "cf-mitigated": "challenge",
            },
          }),
      ),
    );

    expect(await runDoctorCmd({ auth: true, json: true })).toBe(1);
    const out = json();
    expect(out).toMatchObject({
      ok: false,
      error: "edge_blocked",
      status: 403,
      details: {
        nonJson: true,
        contentType: "text/html",
        cfRay: "ray-999-DFW",
      },
    });
    expect(out.breadcrumbs ?? []).toEqual([]);
  });

  it("reports key_unusable with self-revoke breadcrumb when /api-keys/self answers for refused key", async () => {
    process.env.CREEK_TOKEN = TOKEN_UNUSABLE;
    server.use(
      http.get(`${API}/api/auth/get-session`, () =>
        HttpResponse.json({ error: "team_mismatch" }, { status: 403 }),
      ),
      http.get(`${API}/api-keys/self`, () =>
        HttpResponse.json(
          makeKeySelf({
            id: "key-unusable",
            access: "none",
            effectiveScopes: [],
            warning: "The key's owner is no longer a member of the team.",
          }),
        ),
      ),
    );

    expect(await runDoctorCmd({ auth: true, json: true })).toBe(1);
    const out = json();
    expect(out).toMatchObject({
      ok: false,
      error: "key_unusable",
      key: { id: "key-unusable", access: "none" },
    });
    const cmds = (out.breadcrumbs as Array<{ command: string }>).map((b) => b.command);
    expect(cmds).toContain("creek keys revoke --self --json");
  });

  it("passes --auth --prod for a ci-deploy key against an existing monorepo subdirectory", async () => {
    mkdirSync(join(workDir, "apps/web"), { recursive: true });
    writeFileSync(join(workDir, "apps/web/creek.toml"), '[project]\nname = "web"\n');
    process.env.CREEK_TOKEN = TOKEN_CI;

    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () => HttpResponse.json(makeKeySelf({}))),
      http.get(`${API}/projects/web`, () =>
        HttpResponse.json({ id: "proj-web", slug: "web", name: "web" }),
      ),
    );

    expect(await runDoctorCmd({ path: "apps/web", auth: true, prod: true, json: true })).toBe(0);
    const out = json();
    expect(out).toMatchObject({
      ok: true,
      mode: "auth",
      target: "production",
      user: { id: "u1", email: "owner@example.com" },
      project: {
        slug: "web",
        id: "proj-web",
        source: "creek.toml",
        exists: true,
        canAccess: true,
      },
    });
    expect(out.checks.every((c: { status: string }) => c.status === "pass")).toBe(true);
    expect(out.breadcrumbs.map((b: { command: string }) => b.command)).toContain(
      "creek deploy --path apps/web --prod --json",
    );
  });

  it("requires project:write on --auth --prod when the project does not exist yet (404)", async () => {
    writeFileSync(join(workDir, "creek.toml"), '[project]\nname = "brand-new"\n');
    process.env.CREEK_TOKEN = TOKEN_CI;

    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () => HttpResponse.json(makeKeySelf({}))),
      http.get(`${API}/projects/brand-new`, () =>
        HttpResponse.json({ error: "not_found" }, { status: 404 }),
      ),
    );

    expect(await runDoctorCmd({ auth: true, prod: true, json: true })).toBe(1);
    const out = json();
    expect(out).toMatchObject({
      ok: false,
      error: "insufficient_scope",
      project: { slug: "brand-new", exists: false, canAccess: null },
    });
    const scopesCheck = out.checks.find((c: { id: string }) => c.id === "scopes");
    expect(scopesCheck).toMatchObject({
      status: "fail",
      code: "insufficient_scope",
      details: { missing: ["project:write"] },
    });
  });

  it("warns on read-only key without --prod, and fails with insufficient_scope with --prod", async () => {
    process.env.CREEK_TOKEN = TOKEN_RO;
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () =>
        HttpResponse.json(
          makeKeySelf({
            scopes: ["project:read"],
            effectiveScopes: ["project:read"],
          }),
        ),
      ),
    );

    expect(await runDoctorCmd({ auth: true, json: true })).toBe(0);
    const general = json();
    expect(general.ok).toBe(true);
    expect(general.checks.find((c: { id: string }) => c.id === "scopes")).toMatchObject({
      status: "warn",
      code: "missing_deploy_scopes",
    });

    stdout = "";
    expect(await runDoctorCmd({ auth: true, prod: true, json: true })).toBe(1);
    const prodOut = json();
    expect(prodOut).toMatchObject({ ok: false, error: "insufficient_scope" });
    expect(prodOut.checks.find((c: { id: string }) => c.id === "scopes")).toMatchObject({
      status: "fail",
      code: "insufficient_scope",
      details: { missing: ["deploy:production"] },
    });
  });

  it("classifies role-demoted missing scope as insufficient_role on --auth --prod", async () => {
    process.env.CREEK_TOKEN = TOKEN_DEMOTED;
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () =>
        HttpResponse.json(
          makeKeySelf({
            scopes: ["project:read", "deploy:production"],
            effectiveScopes: ["project:read"],
            role: "viewer",
          }),
        ),
      ),
    );

    expect(await runDoctorCmd({ auth: true, prod: true, json: true })).toBe(1);
    const out = json();
    expect(out).toMatchObject({ ok: false, error: "insufficient_role" });
    expect(out.checks.find((c: { id: string }) => c.id === "scopes")).toMatchObject({
      status: "fail",
      code: "insufficient_role",
      details: { droppedByRole: ["deploy:production"] },
    });
  });

  it("skips GET /projects/:slug when scoped key lacks project:read and fails on scopes", async () => {
    process.env.CREEK_TOKEN = TOKEN_NO_READ;
    let projectRequested = false;
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () =>
        HttpResponse.json(
          makeKeySelf({
            scopes: ["deploy:production"],
            effectiveScopes: ["deploy:production"],
          }),
        ),
      ),
      http.get(`${API}/projects/*`, () => {
        projectRequested = true;
        return HttpResponse.json({ id: "p1", slug: "app" });
      }),
    );

    expect(await runDoctorCmd({ project: "app", auth: true, prod: true, json: true })).toBe(1);
    expect(projectRequested).toBe(false);
    const out = json();
    expect(out).toMatchObject({ ok: false, error: "insufficient_scope" });
    expect(out.checks.find((c: { id: string }) => c.id === "project")).toMatchObject({
      status: "skip",
      code: "missing_project_read",
    });
    expect(out.checks.find((c: { id: string }) => c.id === "scopes")).toMatchObject({
      status: "fail",
      details: { missing: ["project:read"] },
    });
  });

  it("succeeds for legacy key outside any project directory", async () => {
    process.env.CREEK_TOKEN = TOKEN_LEGACY;
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () =>
        HttpResponse.json(
          makeKeySelf({
            id: "key-legacy",
            name: null,
            legacy: true,
            team: null,
            scopes: null,
            role: null,
            effectiveScopes: null,
            access: "full",
          }),
        ),
      ),
    );

    expect(await runDoctorCmd({ auth: true, prod: true, json: true })).toBe(0);
    const out = json();
    expect(out.ok).toBe(true);
    expect(out.checks.find((c: { id: string }) => c.id === "project")).toMatchObject({
      status: "skip",
      code: "no_project",
    });
    expect(out.checks.find((c: { id: string }) => c.id === "scopes")).toMatchObject({
      status: "pass",
      code: "legacy_key_unscoped",
    });
    expect(out.breadcrumbs ?? []).toEqual([]);
  });

  it("validates flag combinations and missing directory paths", async () => {
    expect(await runDoctorCmd({ auth: true, last: true, json: true })).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "conflicting_flags" });

    stdout = "";
    expect(await runDoctorCmd({ prod: true, json: true })).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "invalid_args" });

    stdout = "";
    expect(await runDoctorCmd({ path: "does-not-exist", auth: true, json: true })).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_found" });
  });

  it("skips cloud project lookup for creekd target projects", async () => {
    writeFileSync(
      join(workDir, "creek.toml"),
      '[project]\nname = "self-hosted"\ntarget = "creekd"\n',
    );
    process.env.CREEK_TOKEN = TOKEN_CI;
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () => HttpResponse.json(makeKeySelf({}))),
    );

    expect(await runDoctorCmd({ auth: true, json: true })).toBe(0);
    const out = json();
    expect(out.ok).toBe(true);
    expect(out.checks.find((c: { id: string }) => c.id === "project")).toMatchObject({
      status: "skip",
      code: "creekd_target",
    });
  });

  it("renders human output cleanly on pass (resolves 0) and fail (exits 1)", async () => {
    const logSpy = vi.spyOn(consola, "log").mockImplementation(() => {});
    process.env.CREEK_TOKEN = TOKEN_CI;
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () => HttpResponse.json(makeKeySelf({}))),
    );

    await expect(
      runAuthDoctor({ cwd: workDir, project: undefined, prod: true, jsonMode: false }),
    ).resolves.toBeUndefined();
    expect(stdout).toBe("");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("creek doctor --auth");

    delete process.env.CREEK_TOKEN;
    const code = await runExit(
      runAuthDoctor({ cwd: workDir, project: undefined, prod: true, jsonMode: false }),
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
  });

  it("rejects NUL-containing saved tokens before fetch without leaking the secret", async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/*`, () => {
        calls++;
        return HttpResponse.json(SESSION);
      }),
    );
    let stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
    const logSpy = vi.spyOn(consola, "log").mockImplementation(() => {});
    saveConfig({ token: "crk_sk_live_secretNulLeak\0tail" });

    expect(await runDoctorCmd({ auth: true, json: true })).toBe(1);
    expect(calls).toBe(0);
    expect(json()).toMatchObject({
      ok: false,
      error: "invalid_token_format",
      tokenFormatIssue: "contains_nul",
      tokenSource: "config",
    });
    expect(stdout).not.toContain("secretNulLeak");
    expect(stderr).not.toContain("secretNulLeak");

    stdout = "";
    const code = await runExit(
      runAuthDoctor({ cwd: workDir, project: undefined, prod: false, jsonMode: false }),
    );
    expect(code).toBe(1);
    expect(calls).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("secretNulLeak");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("secretNulLeak");
    expect(logSpy.mock.calls.flat().join("\n")).toContain("NUL character");
  });

  it("redacts the active token if an unexpected header/fetch error echoes it", async () => {
    process.env.CREEK_TOKEN = TOKEN_CI;
    let stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
    const logSpy = vi.spyOn(consola, "log").mockImplementation(() => {});
    const spy = vi
      .spyOn(CreekClient.prototype, "getSession")
      .mockRejectedValueOnce(
        new TypeError(`Headers.append: "${TOKEN_CI}" is an invalid header value.`),
      )
      .mockRejectedValueOnce(
        new TypeError(`Headers.append: "${TOKEN_CI}" is an invalid header value.`),
      );

    expect(await runDoctorCmd({ auth: true, json: true })).toBe(1);
    const out = json();
    expect(out).toMatchObject({
      ok: false,
      error: "api_error",
    });
    expect(String(out.message)).toContain("[REDACTED]");
    expect(stdout).not.toContain(TOKEN_CI);
    expect(stderr).not.toContain(TOKEN_CI);

    stdout = "";
    const code = await runExit(
      runAuthDoctor({ cwd: workDir, project: undefined, prod: false, jsonMode: false }),
    );
    expect(code).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(stdout).toBe("");
    expect(stderr).not.toContain(TOKEN_CI);
    const humanOut = logSpy.mock.calls.flat().join("\n");
    expect(humanOut).toContain("[REDACTED]");
    expect(humanOut).not.toContain(TOKEN_CI);
  });

  it("fails --auth --prod when /api-keys/self errors after a valid session, while preserving server_unsupported compat", async () => {
    process.env.CREEK_TOKEN = TOKEN_CI;
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () =>
        HttpResponse.json({ error: "service_unavailable" }, { status: 503 }),
      ),
    );

    expect(await runDoctorCmd({ auth: true, prod: true, json: true })).toBe(1);
    const out = json();
    expect(out).toMatchObject({
      ok: false,
      error: "lookup_failed",
      status: 503,
    });
    expect(out.checks.find((c: { id: string }) => c.id === "key")).toMatchObject({
      status: "fail",
      code: "lookup_failed",
    });
    expect(out.checks.find((c: { id: string }) => c.id === "scopes")).toMatchObject({
      status: "skip",
      code: "key_lookup_failed",
    });

    // Compatibility with older control-planes without /api-keys/self still passes.
    stdout = "";
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () =>
        HttpResponse.json({ error: "not_found" }, { status: 404 }),
      ),
    );
    expect(await runDoctorCmd({ auth: true, prod: true, json: true })).toBe(0);
    const compat = json();
    expect(compat.ok).toBe(true);
    expect(compat.checks.find((c: { id: string }) => c.id === "key")).toMatchObject({
      status: "skip",
      code: "server_unsupported",
    });
  });

  it("reports /api-keys/self edge blocks and 503 lookup_failed separately when session returns null", async () => {
    process.env.CREEK_TOKEN = TOKEN_CI;
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(null, { status: 401 })),
      http.get(
        `${API}/api-keys/self`,
        () =>
          new HttpResponse("<html>WAF blocked</html>", {
            status: 403,
            headers: { "content-type": "text/html", "cf-ray": "ray-self-1" },
          }),
      ),
    );

    expect(await runDoctorCmd({ auth: true, json: true })).toBe(1);
    const blocked = json();
    expect(blocked).toMatchObject({
      ok: false,
      error: "edge_blocked",
      status: 403,
      details: { nonJson: true, cfRay: "ray-self-1" },
    });
    expect(blocked.breadcrumbs ?? []).toEqual([]);

    stdout = "";
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(null, { status: 401 })),
      http.get(`${API}/api-keys/self`, () =>
        HttpResponse.json({ error: "unavailable" }, { status: 503 }),
      ),
    );
    expect(await runDoctorCmd({ auth: true, json: true })).toBe(1);
    const lookupOut = json();
    expect(lookupOut).toMatchObject({
      ok: false,
      error: "lookup_failed",
      status: 503,
    });
    expect(lookupOut.breadcrumbs ?? []).toEqual([]);
  });

  it("preserves checked path and --project in follow-ups and suppresses unsafe deploy breadcrumbs", async () => {
    mkdirSync(join(workDir, "apps/web"), { recursive: true });
    writeFileSync(join(workDir, "apps/web/creek.toml"), '[project]\nname = "web"\n');
    process.env.CREEK_TOKEN = TOKEN_CI;

    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () => HttpResponse.json(makeKeySelf({}))),
      http.get(`${API}/projects/web`, () =>
        HttpResponse.json({ id: "proj-web", slug: "web", name: "web" }),
      ),
      http.get(`${API}/projects/other-app`, () =>
        HttpResponse.json({ id: "proj-other", slug: "other-app", name: "other-app" }),
      ),
    );

    // Non-prod check on subdir preserves path in --prod follow-up.
    expect(await runDoctorCmd({ path: "apps/web", auth: true, json: true })).toBe(0);
    expect(json().breadcrumbs[0].command).toBe("creek doctor apps/web --auth --prod --json");

    // Non-prod check with --project preserves --project in --prod follow-up.
    stdout = "";
    expect(await runDoctorCmd({ project: "web", auth: true, json: true })).toBe(0);
    expect(json().breadcrumbs[0].command).toBe("creek doctor --project web --auth --prod --json");

    // --prod with explicit --project pointing at a different slug suppresses bare deploy breadcrumb.
    stdout = "";
    process.chdir(join(workDir, "apps/web"));
    expect(await runDoctorCmd({ project: "other-app", auth: true, prod: true, json: true })).toBe(
      0,
    );
    const suppressed = json();
    expect(suppressed.breadcrumbs ?? []).toEqual([]);
  });

  it("warns legacy_role_unverified when checking --auth --prod for a legacy key on a missing project", async () => {
    writeFileSync(join(workDir, "creek.toml"), '[project]\nname = "brand-new"\n');
    process.env.CREEK_TOKEN = TOKEN_LEGACY;
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () =>
        HttpResponse.json(
          makeKeySelf({
            id: "key-legacy",
            name: null,
            legacy: true,
            team: null,
            scopes: null,
            role: null,
            effectiveScopes: null,
            access: "full",
          }),
        ),
      ),
      http.get(`${API}/projects/brand-new`, () =>
        HttpResponse.json({ error: "not_found" }, { status: 404 }),
      ),
    );

    expect(await runDoctorCmd({ auth: true, prod: true, json: true })).toBe(0);
    const out = json();
    expect(out.ok).toBe(true);
    expect(out.checks.find((c: { id: string }) => c.id === "scopes")).toMatchObject({
      status: "warn",
      code: "legacy_role_unverified",
      details: {
        unverifiedPermissions: ["project:create"],
      },
    });
  });

  it("suppresses cloud deploy breadcrumbs for creekd targets even when --project matches", async () => {
    writeFileSync(
      join(workDir, "creek.toml"),
      '[project]\nname = "self-hosted"\ntarget = "creekd"\n',
    );
    mkdirSync(join(workDir, "apps/self-hosted"), { recursive: true });
    writeFileSync(
      join(workDir, "apps/self-hosted/creek.toml"),
      '[project]\nname = "self-hosted"\ntarget = "creekd"\n',
    );
    process.env.CREEK_TOKEN = TOKEN_CI;
    server.use(
      http.get(`${API}/api/auth/get-session`, () => HttpResponse.json(SESSION)),
      http.get(`${API}/api-keys/self`, () => HttpResponse.json(makeKeySelf({}))),
      http.get(`${API}/projects/self-hosted`, () =>
        HttpResponse.json({ id: "proj-sh", slug: "self-hosted", name: "self-hosted" }),
      ),
    );

    // Explicit --project matching cwd's creekd project name must not emit `creek deploy --prod --json`.
    expect(await runDoctorCmd({ project: "self-hosted", auth: true, prod: true, json: true })).toBe(
      0,
    );
    const cwdMatchOut = json();
    expect(cwdMatchOut).toMatchObject({
      ok: true,
      project: { slug: "self-hosted", exists: true, canAccess: true },
    });
    expect(cwdMatchOut.breadcrumbs ?? []).toEqual([]);

    // Explicit --project matching checked [path] subdirectory's creekd project must also suppress deploy breadcrumb.
    stdout = "";
    expect(
      await runDoctorCmd({
        path: "apps/self-hosted",
        project: "self-hosted",
        auth: true,
        prod: true,
        json: true,
      }),
    ).toBe(0);
    const subpathMatchOut = json();
    expect(subpathMatchOut.ok).toBe(true);
    expect(subpathMatchOut.breadcrumbs ?? []).toEqual([]);

    // Without --project, creekd target skips cloud project lookup and emits no cloud deploy breadcrumb.
    stdout = "";
    expect(await runDoctorCmd({ auth: true, prod: true, json: true })).toBe(0);
    const implicitOut = json();
    expect(implicitOut.ok).toBe(true);
    expect(implicitOut.checks.find((c: { id: string }) => c.id === "project")).toMatchObject({
      status: "skip",
      code: "creekd_target",
    });
    expect(implicitOut.breadcrumbs ?? []).toEqual([]);
  });
});
