import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CreekClient } from "@solcreek/sdk";
import { statusCommand } from "./status.js";
import { opsCommand } from "./ops.js";
import { claimCommand } from "./claim.js";
import { envCommand } from "./env.js";
import { resolveShellDatabase } from "./db.js";
import { projectsCommand } from "./projects.js";
import { domainsCommand } from "./domains.js";
import { doctorCommand } from "./doctor.js";
import { logsCommand } from "./logs.js";
import { metricsCommand } from "./metrics.js";
import { queueCommand } from "./queue.js";
import { deploymentsCommand } from "./deployments.js";
import { rollbackCommand } from "./rollback.js";
import { dbCommand } from "./db.js";

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

describe("creek status (project)", () => {
  let projDir: string;
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
    projDir = mkdtempSync(join(tmpdir(), "creek-status-test-"));
    writeFileSync(join(projDir, "creek.toml"), '[project]\nname = "demo"\n');
    process.chdir(projDir);
    process.env.CREEK_TOKEN = "tok";
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(projDir, { recursive: true, force: true });
  });

  it("says the project came from creek.toml", async () => {
    server.use(
      http.get(`${API}/projects/demo`, () =>
        HttpResponse.json({
          id: "p1",
          slug: "demo",
          framework: null,
          production_deployment_id: null,
          created_at: 0,
        }),
      ),
      // The binding-drift check (cwd is this cf project).
      http.get(`${API}/projects/demo/bindings`, () => HttpResponse.json({ bindings: [] })),
    );
    const code = await runExit(statusCommand.run!({ args: {} } as never));
    expect(code).toBe(0);
    const out = json();
    expect(out).toMatchObject({ ok: true, project: "demo", projectSource: "creek.toml" });
    // The cwd is this project, so a bare deploy is the right next step.
    expect(out.breadcrumbs.map((b: { command: string }) => b.command)).toContain("creek deploy");
  });

  it("--project naming another project never suggests a bare deploy (it would ship the cwd's)", async () => {
    const other = {
      id: "p2",
      slug: "other",
      framework: null,
      production_deployment_id: null,
      created_at: 0,
    };
    server.use(http.get(`${API}/projects/other`, () => HttpResponse.json(other)));
    expect(await runExit(statusCommand.run!({ args: { project: "other" } } as never))).toBe(0);
    let commands = json().breadcrumbs.map((b: { command: string }) => b.command);
    expect(commands.some((c: string) => /^creek deploy( |$)/.test(c))).toBe(false);

    stdout = "";
    server.use(
      http.get(`${API}/projects/gone`, () =>
        HttpResponse.json({ error: "not_found", message: "Project not found" }, { status: 404 }),
      ),
    );
    expect(await runExit(statusCommand.run!({ args: { project: "gone" } } as never))).toBe(1);
    commands = json().breadcrumbs.map((b: { command: string }) => b.command);
    expect(commands.some((c: string) => /^creek deploy( |$)/.test(c))).toBe(false);
  });

  it("`domains ls` says where its project came from", async () => {
    server.use(http.get(`${API}/projects/demo/domains`, () => HttpResponse.json([])));
    const ls = (domainsCommand.subCommands as Record<string, { run?: (c: never) => unknown }>).ls;
    const code = await runExit(Promise.resolve(ls.run!({ args: { _: [] } } as never)));
    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, project: "demo", projectSource: "creek.toml" });
  });

  it("reports a missing project (404) as not_found", async () => {
    server.use(
      http.get(`${API}/projects/demo`, () =>
        HttpResponse.json({ error: "not_found", message: "Project not found" }, { status: 404 }),
      ),
    );
    const code = await runExit(statusCommand.run!({ args: {} } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_found", status: 404 });
  });

  it("does not report a refused key (403) as a missing project", async () => {
    server.use(
      http.get(`${API}/projects/demo`, () =>
        HttpResponse.json(
          {
            error: "insufficient_scope",
            message: "This API key lacks the scope: project:read",
            required: ["project:read"],
            granted: ["deploy:preview"],
          },
          { status: 403 },
        ),
      ),
    );
    const code = await runExit(statusCommand.run!({ args: {} } as never));
    expect(code).toBe(1);
    expect(json()).toEqual({
      ok: false,
      error: "api_error",
      message: "This API key lacks the scope: project:read",
      status: 403,
      apiError: "insufficient_scope",
      details: { required: ["project:read"], granted: ["deploy:preview"] },
    });
  });
});

describe("creek status <id> (sandbox)", () => {
  it("prints the sandbox status as JSON and exits 0", async () => {
    server.use(
      http.get(`${SBX}/api/sandbox/sb-1/status`, () =>
        HttpResponse.json({
          sandboxId: "sb-1",
          status: "active",
          previewUrl: "https://sb-1.test",
          claimable: true,
          expiresInSeconds: 3600,
        }),
      ),
    );
    const code = await runExit(statusCommand.run!({ args: { id: "sb-1" } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      type: "sandbox",
      status: "active",
      sandboxId: "sb-1",
    });
  });

  it("exits 1 with a not_found error when the sandbox is gone", async () => {
    server.use(
      http.get(`${SBX}/api/sandbox/gone/status`, () => new HttpResponse(null, { status: 404 })),
    );
    const code = await runExit(statusCommand.run!({ args: { id: "gone" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("creek ops deployments", () => {
  it("lists deployments with the API key in x-api-key and exits 0", async () => {
    process.env.CREEK_TOKEN = "tok-abc";
    let apiKey = "";
    let authorization: string | null = null;
    server.use(
      http.get(`${API}/web-deploy/list`, ({ request }) => {
        apiKey = request.headers.get("x-api-key") ?? "";
        authorization = request.headers.get("authorization");
        return HttpResponse.json([
          { environment: "sandbox", buildId: "b1" },
          { environment: "production", buildId: "b2" },
        ]);
      }),
    );
    const code = await runExit(opsCommand.run!({ args: { sub: "deployments" } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, count: 2 });
    // The control-plane reads keys from x-api-key only; Bearer was ignored.
    expect(apiKey).toBe("tok-abc");
    expect(authorization).toBeNull();
  });

  it("exits 1 (not_authenticated) without a token, before any request", async () => {
    const code = await runExit(opsCommand.run!({ args: { sub: "deployments" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_authenticated" });
    expect(json().breadcrumbs[0].command).toContain("creek login --token");
  });

  it("maps a 401 to not_authenticated", async () => {
    process.env.CREEK_TOKEN = "tok-revoked";
    server.use(
      http.get(`${API}/web-deploy/list`, () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );
    const code = await runExit(opsCommand.run!({ args: { sub: "deployments" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_authenticated" });
  });

  it("maps a 403 to forbidden for a non-admin account", async () => {
    process.env.CREEK_TOKEN = "tok-member";
    server.use(
      http.get(`${API}/web-deploy/list`, () =>
        HttpResponse.json({ error: "forbidden" }, { status: 403 }),
      ),
    );
    const code = await runExit(opsCommand.run!({ args: { sub: "deployments" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "forbidden" });
    expect(json().message).toContain("platform admin");
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
    const code = await runExit(
      opsCommand.run!({ args: { sub: "deployments", env: "production" } } as never),
    );
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
        HttpResponse.json({
          sandboxId: "sb-old",
          status: "expired",
          claimable: false,
          framework: null,
          templateId: null,
        }),
      ),
    );
    const code = await runExit(claimCommand.run!({ args: { sandboxId: "sb-old" } } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_claimable", status: "expired" });
  });

  it("on success makes clear the project is a shell with no deployment", async () => {
    process.env.CREEK_TOKEN = "tok";
    server.use(
      http.get(`${SBX}/api/sandbox/sb-ok/status`, () =>
        HttpResponse.json({
          sandboxId: "sb-ok",
          status: "active",
          claimable: true,
          framework: "vite",
          templateId: "landing",
        }),
      ),
      http.post(`${API}/projects`, () =>
        HttpResponse.json({ project: { id: "proj-1", slug: "landing" } }),
      ),
      http.post(`${SBX}/api/sandbox/sb-ok/claim`, () => HttpResponse.json({ ok: true })),
    );
    const code = await runExit(claimCommand.run!({ args: { sandboxId: "sb-ok" } } as never));
    expect(code).toBe(0);
    // Claim only reserves the project — agents must not assume it's live.
    const out = json();
    expect(out).toMatchObject({
      ok: true,
      project: "landing",
      deployed: false,
      productionDeploymentId: null,
    });
    expect(out.note).toMatch(/deploy/i);
    const deployCrumb = out.breadcrumbs.find(
      (b: { command: string }) => b.command === "creek deploy",
    );
    expect(deployCrumb.description).toMatch(/required/i);
  });
});

describe("creek env", () => {
  // env reads the project slug from creek.toml in cwd, so set up a temp
  // project and chdir into it for these tests.
  let projDir: string;
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
    projDir = mkdtempSync(join(tmpdir(), "creek-env-test-"));
    writeFileSync(
      join(projDir, "creek.toml"),
      '[project]\nname = "demo"\n[build]\ncommand = "npm run build"\noutput = "dist"\n',
    );
    process.chdir(projDir);
    process.env.CREEK_TOKEN = "tok";
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(projDir, { recursive: true, force: true });
  });

  it("`unset` is an alias of `rm` and actually removes the var", async () => {
    // Wiring: the unset subcommand must dispatch to the same remove handler.
    expect(envCommand.subCommands!.unset).toBe(envCommand.subCommands!.rm);

    let deleted = "";
    server.use(
      http.delete(`${API}/projects/demo/env/:key`, ({ params }) => {
        deleted = String(params.key);
        return HttpResponse.json({ ok: true });
      }),
    );
    const code = await runExit(
      envCommand.subCommands!.unset.run!({ args: { key: "DEMO_PROBE", _: [] } } as never),
    );
    expect(code).toBe(0);
    expect(deleted).toBe("DEMO_PROBE");
    // Removal isn't live until redeploy — must be signalled structurally.
    expect(json()).toMatchObject({
      ok: true,
      key: "DEMO_PROBE",
      removed: true,
      applied: false,
      pendingDeploy: true,
    });
  });

  it("keeps the API's error code and its fields when a scoped key is refused", async () => {
    server.use(
      http.post(`${API}/projects/demo/env`, () =>
        HttpResponse.json(
          {
            error: "insufficient_scope",
            message: "This API key lacks the scope: env:write",
            required: ["env:write"],
            requiredMode: "all",
            granted: ["deploy:preview", "project:read"],
          },
          { status: 403 },
        ),
      ),
    );
    const code = await runExit(
      envCommand.subCommands!.set.run!({ args: { key: "DEMO_PROBE", value: "1", _: [] } } as never),
    );
    expect(code).toBe(1);
    // `error` stays the command's code; the API's code and fields are added.
    expect(json()).toEqual({
      ok: false,
      error: "set_failed",
      message: "This API key lacks the scope: env:write",
      status: 403,
      apiError: "insufficient_scope",
      details: {
        required: ["env:write"],
        requiredMode: "all",
        granted: ["deploy:preview", "project:read"],
      },
    });
  });

  it("adds no API fields to an error that is not from the API", async () => {
    server.use(http.post(`${API}/projects/demo/env`, () => HttpResponse.error()));
    const code = await runExit(
      envCommand.subCommands!.set.run!({ args: { key: "DEMO_PROBE", value: "1", _: [] } } as never),
    );
    expect(code).toBe(1);
    const out = json();
    expect(out).toMatchObject({ ok: false, error: "set_failed" });
    expect(out).not.toHaveProperty("apiError");
    expect(out).not.toHaveProperty("status");
  });

  it("`set` signals the change is pending a deploy (not yet live)", async () => {
    server.use(
      http.post(`${API}/projects/demo/env`, () =>
        HttpResponse.json({ ok: true, key: "DEMO_PROBE" }),
      ),
    );
    const code = await runExit(
      envCommand.subCommands!.set.run!({ args: { key: "DEMO_PROBE", value: "1", _: [] } } as never),
    );
    expect(code).toBe(0);
    const out = json();
    expect(out).toMatchObject({ ok: true, key: "DEMO_PROBE", applied: false, pendingDeploy: true });
    // The redeploy step must remain in the breadcrumbs.
    expect(JSON.stringify(out.breadcrumbs)).toContain("creek deploy");
  });

  it("--project naming another project: set/ls/rm/unset never suggest a bare deploy", async () => {
    // cwd is project "demo"; a bare `creek deploy` here would ship demo, not other.
    server.use(
      http.post(`${API}/projects/other/env`, () => HttpResponse.json({ ok: true, key: "K" })),
      http.get(`${API}/projects/other/env`, () =>
        HttpResponse.json([{ key: "K", value: "secret-value", target: "all" }]),
      ),
      http.delete(`${API}/projects/other/env/K`, () => HttpResponse.json({ ok: true })),
    );
    const sub = envCommand.subCommands as Record<string, { run?: (c: never) => unknown }>;
    const runs: [string, Record<string, unknown>][] = [
      ["set", { key: "K", value: "v" }],
      ["ls", { show: false }],
      ["rm", { key: "K" }],
      ["unset", { key: "K" }],
    ];
    for (const [name, args] of runs) {
      stdout = "";
      const code = await runExit(
        Promise.resolve(sub[name].run!({ args: { ...args, project: "other", _: [] } } as never)),
      );
      expect(code, name).toBe(0);
      const commands = json().breadcrumbs.map((b: { command: string }) => b.command);
      expect(
        commands.filter((c: string) => /^creek deploy( |$)/.test(c)),
        name,
      ).toEqual([]);
    }
  });
});

describe("creek env in a wrangler-only project", () => {
  // No creek.toml: the project is the wrangler config's name, the same one
  // `creek deploy` deploys as. Previously env failed here with no_project and
  // pointed at a --project flag it did not accept.
  let projDir: string;
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
    projDir = mkdtempSync(join(tmpdir(), "creek-env-wrangler-test-"));
    writeFileSync(
      join(projDir, "wrangler.jsonc"),
      '{\n  // a worker\n  "name": "wrangler-app",\n  "main": "src/index.ts",\n  "compatibility_date": "2026-01-01"\n}\n',
    );
    process.chdir(projDir);
    process.env.CREEK_TOKEN = "tok";
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(projDir, { recursive: true, force: true });
  });

  it("`set` with no flags targets the wrangler name", async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/projects/wrangler-app/env`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true, key: "K" });
      }),
    );
    const code = await runExit(
      envCommand.subCommands!.set.run!({ args: { key: "K", value: "v", _: [] } } as never),
    );
    expect(code).toBe(0);
    expect(body).toEqual({ key: "K", value: "v" });
    expect(json()).toMatchObject({
      ok: true,
      key: "K",
      project: "wrangler-app",
      projectSource: "wrangler",
    });
  });

  it("`ls` and `rm` with no flags target the wrangler name", async () => {
    server.use(
      http.get(`${API}/projects/wrangler-app/env`, () =>
        HttpResponse.json([{ key: "K", value: "secret-value", target: "all" }]),
      ),
      http.delete(`${API}/projects/wrangler-app/env/K`, () => HttpResponse.json({ ok: true })),
    );
    expect(
      await runExit(envCommand.subCommands!.ls.run!({ args: { show: false, _: [] } } as never)),
    ).toBe(0);
    expect(json()).toMatchObject({ ok: true, project: "wrangler-app", vars: [{ key: "K" }] });
    stdout = "";
    expect(
      await runExit(envCommand.subCommands!.rm.run!({ args: { key: "K", _: [] } } as never)),
    ).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      key: "K",
      removed: true,
      project: "wrangler-app",
      projectSource: "wrangler",
    });
  });

  it("--project wins over the wrangler name and is carried into breadcrumbs", async () => {
    server.use(
      http.get(`${API}/projects/other/env`, () =>
        HttpResponse.json([{ key: "K", value: "secret-value", target: "all" }]),
      ),
    );
    const code = await runExit(
      envCommand.subCommands!.ls.run!({
        args: { project: "other", show: false, _: [] },
      } as never),
    );
    expect(code).toBe(0);
    const out = json();
    expect(out).toMatchObject({ ok: true, project: "other", projectSource: "flag" });
    const commands = (out.breadcrumbs as { command: string }[]).map((b) => b.command);
    expect(commands).toContain("creek env rm K --project other");
  });
});

describe("project commands in a directory whose config names no project", () => {
  // resolveConfig would guess the directory name here. With no MSW handler
  // registered, any API call fails the test (onUnhandledRequest: "error"), so
  // these also prove nothing reached a project named after the directory.
  let projDir: string;
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
    projDir = mkdtempSync(join(tmpdir(), "web-"));
    process.chdir(projDir);
    process.env.CREEK_TOKEN = "tok";
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(projDir, { recursive: true, force: true });
  });

  it("`status --project <the name deploy used>` still reports the local config and drift", async () => {
    // A nameless wrangler config deploys under the directory name. Naming
    // that project explicitly must show this directory's config, not drop it.
    writeFileSync(
      join(projDir, "wrangler.jsonc"),
      JSON.stringify({
        main: "src/index.ts",
        kv_namespaces: [{ binding: "CACHE", id: "x" }],
        triggers: { crons: ["*/5 * * * *"] },
      }),
    );
    const slug = basename(projDir)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    let driftChecked = false;
    server.use(
      http.get(`${API}/projects/${slug}`, () =>
        HttpResponse.json({
          id: "p1",
          slug,
          framework: null,
          production_deployment_id: null,
          created_at: 0,
        }),
      ),
      http.get(`${API}/projects/${slug}/bindings`, () => {
        driftChecked = true;
        return HttpResponse.json({ bindings: [] });
      }),
    );
    const code = await runExit(statusCommand.run!({ args: { project: slug } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      project: slug,
      projectSource: "flag",
      config: "wrangler.jsonc",
      bindings: ["kv"],
      cron: ["*/5 * * * *"],
    });
    expect(driftChecked).toBe(true);
  });

  const layouts: [string, (dir: string) => void, string][] = [
    ["index.html only", (d) => writeFileSync(join(d, "index.html"), "<h1>hi</h1>"), "index.html"],
    [
      "wrangler.jsonc without name",
      (d) =>
        writeFileSync(
          join(d, "wrangler.jsonc"),
          '{ "main": "src/index.ts", "compatibility_date": "2026-01-01" }',
        ),
      "wrangler.jsonc",
    ],
  ];
  for (const [label, setup, file] of layouts) {
    it(`${label}: \`env set\` (mutating) is no_project`, async () => {
      setup(projDir);
      const code = await runExit(
        envCommand.subCommands!.set.run!({ args: { key: "K", value: "v", _: [] } } as never),
      );
      expect(code).toBe(1);
      expect(json()).toMatchObject({ ok: false, error: "no_project", foundConfig: file });
    });

    it(`${label}: \`status\` (read) is no_project`, async () => {
      setup(projDir);
      const code = await runExit(statusCommand.run!({ args: {} } as never));
      expect(code).toBe(1);
      expect(json()).toMatchObject({ ok: false, error: "no_project", foundConfig: file });
    });

    it(`${label}: db shell inference is no_project with foundConfig, not no_database_specified`, async () => {
      setup(projDir);
      const code = await runExit(
        resolveShellDatabase(new CreekClient(API, "tok"), { jsonMode: true }),
      );
      expect(code).toBe(1);
      const out = json();
      expect(out).toMatchObject({ ok: false, error: "no_project", foundConfig: file });
      expect(out.message).toContain("never use the directory name");
    });

    it(`${label}: \`doctor --last\` is no_project with foundConfig`, async () => {
      setup(projDir);
      const code = await runExit(
        Promise.resolve(doctorCommand.run!({ args: { last: true, _: [] } } as never)),
      );
      expect(code).toBe(1);
      expect(json()).toMatchObject({ ok: false, error: "no_project", foundConfig: file });
    });
  }
});

describe("every project command reports projectSource", () => {
  // Table-driven: run each project command with --project from a directory
  // with no config, and read projectSource from its JSON output. The source
  // scan in command-context.test.ts makes sure a new project command lands
  // in this table.
  let dir: string;
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "creek-project-source-"));
    process.chdir(dir);
    process.env.CREEK_TOKEN = "tok";
    const dep = "00000000-0000-4000-8000-000000000001";
    server.use(
      http.post(`${API}/projects/p/env`, () => HttpResponse.json({ ok: true, key: "K" })),
      http.get(`${API}/projects/p/env`, () => HttpResponse.json([])),
      http.delete(`${API}/projects/p/env/K`, () => HttpResponse.json({ ok: true })),
      http.get(`${API}/projects/p`, () =>
        HttpResponse.json({
          id: "p1",
          slug: "p",
          framework: null,
          production_deployment_id: null,
          created_at: 0,
        }),
      ),
      http.get(`${API}/projects/p/domains`, () => HttpResponse.json([])),
      http.get(`${API}/projects/p/logs`, () =>
        HttpResponse.json({
          entries: [{ v: 1, timestamp: 1, project: "p", outcome: "ok", logs: [], exceptions: [] }],
          truncated: false,
        }),
      ),
      http.get(`${API}/projects/p/metrics`, () => HttpResponse.json({ period: "24h" })),
      http.post(`${API}/projects/p/queue/send`, () => HttpResponse.json({ queueId: "q1" })),
      http.get(`${API}/projects/p/deployments`, () => HttpResponse.json([])),
      http.get(`${API}/projects/p/deployments/${dep}/logs`, () =>
        HttpResponse.json({ entries: [], metadata: null }),
      ),
      http.post(`${API}/projects/p/rollback`, () =>
        HttpResponse.json({
          ok: true,
          deploymentId: "d2",
          rolledBackTo: dep,
          previousDeploymentId: "d1",
          url: "https://p.test",
        }),
      ),
      http.get(`${API}/projects/p/bindings`, () =>
        HttpResponse.json({
          bindings: [
            {
              bindingName: "DB",
              resourceId: "res-1",
              kind: "database",
              name: "db-1",
              status: "active",
              createdAt: 0,
            },
          ],
        }),
      ),
      http.post(`${API}/resources/res-1/query`, () =>
        HttpResponse.json({
          columns: [],
          rows: [],
          meta: { changes: 0, duration: 1, rows_read: 0, rows_written: 0 },
        }),
      ),
    );
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  type Cmd = { run?: (c: never) => unknown; subCommands?: unknown };
  const sub = (cmd: Cmd, name: string) => (cmd.subCommands as Record<string, Cmd>)[name];
  const dep = "00000000-0000-4000-8000-000000000001";
  const table: [string, () => Cmd, Record<string, unknown>][] = [
    ["env set", () => sub(envCommand as Cmd, "set"), { key: "K", value: "v" }],
    ["env ls", () => sub(envCommand as Cmd, "ls"), { show: false }],
    ["env rm", () => sub(envCommand as Cmd, "rm"), { key: "K" }],
    ["status", () => statusCommand as Cmd, {}],
    ["domains ls", () => sub(domainsCommand as Cmd, "ls"), {}],
    ["logs", () => logsCommand as Cmd, {}],
    ["metrics", () => metricsCommand as Cmd, {}],
    ["queue send", () => sub(queueCommand as Cmd, "send"), { message: "hi", parseJson: false }],
    ["deployments list", () => sub(deploymentsCommand as Cmd, "list"), {}],
    ["deployments logs", () => sub(deploymentsCommand as Cmd, "logs"), { id: dep, raw: false }],
    ["rollback", () => rollbackCommand as Cmd, { deployment: dep }],
    ["doctor --last", () => doctorCommand as Cmd, { last: true }],
    ["db shell --sql", () => sub(dbCommand as Cmd, "shell"), { sql: "SELECT 1" }],
    [
      "db migrate (no files)",
      () => sub(dbCommand as Cmd, "migrate"),
      { dir: ".", "dry-run": false, resume: false },
    ],
  ];

  for (const [name, cmd, args] of table) {
    it(`creek ${name} --project p says projectSource: "flag"`, async () => {
      try {
        await cmd().run!({ args: { ...args, project: "p", _: [] } } as never);
      } catch (err) {
        if (!(err instanceof ExitSignal)) throw err;
      }
      // The first JSON document written. (Commands that wrap their success
      // output in try/catch catch the stubbed process.exit and print a
      // second, bogus error document after it; a real exit never returns.)
      // For `logs --json` it is the first ndjson entry line.
      const first = JSON.parse(stdout.split(/\n(?=\{)/)[0]);
      expect(first).toMatchObject({ project: "p", projectSource: "flag" });
      expect(first.ok, stdout).not.toBe(false);
    });
  }
});

describe("creek doctor --last with a malformed config", () => {
  let projDir: string;
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
    projDir = mkdtempSync(join(tmpdir(), "creek-doctor-badconfig-"));
    process.chdir(projDir);
    process.env.CREEK_TOKEN = "tok";
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(projDir, { recursive: true, force: true });
  });

  for (const [file, content] of [
    ["creek.toml", "[project\nname ="],
    ["wrangler.jsonc", '{ "name": "x", "main": '],
  ]) {
    it(`a broken ${file} is invalid_config with the diagnostic, not no_project`, async () => {
      writeFileSync(join(projDir, file), content);
      const code = await runExit(
        Promise.resolve(doctorCommand.run!({ args: { last: true, _: [] } } as never)),
      );
      expect(code).toBe(1);
      const out = json();
      expect(out).toMatchObject({ ok: false, error: "invalid_config" });
      expect(out.message).toMatch(/^Couldn't read the project config: \S/);
    });
  }
});

describe("project commands outside any project", () => {
  let emptyDir: string;
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
    emptyDir = mkdtempSync(join(tmpdir(), "creek-no-project-test-"));
    process.chdir(emptyDir);
    process.env.CREEK_TOKEN = "tok";
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("`env set` is no_project, and its hint is a flag env accepts", async () => {
    const code = await runExit(
      envCommand.subCommands!.set.run!({ args: { key: "K", value: "v", _: [] } } as never),
    );
    expect(code).toBe(1);
    const out = json();
    expect(out).toMatchObject({ ok: false, error: "no_project" });
    expect(out.message).toContain("--project");
    expect(envCommand.subCommands!.set.args).toHaveProperty("project");
    expect(Array.isArray(out.breadcrumbs)).toBe(true);
  });

  it("`env set --project` works from anywhere", async () => {
    server.use(
      http.post(`${API}/projects/named/env`, () => HttpResponse.json({ ok: true, key: "K" })),
    );
    const code = await runExit(
      envCommand.subCommands!.set.run!({
        args: { key: "K", value: "v", project: "named", _: [] },
      } as never),
    );
    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, project: "named", projectSource: "flag" });
  });

  it("`status --project` reports the server side without a local config", async () => {
    server.use(
      http.get(`${API}/projects/named`, () =>
        HttpResponse.json({
          id: "p1",
          slug: "named",
          framework: null,
          production_deployment_id: null,
          created_at: 0,
        }),
      ),
    );
    const code = await runExit(statusCommand.run!({ args: { project: "named" } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      type: "project",
      project: "named",
      projectSource: "flag",
      config: null,
      bindings: [],
    });
  });
});

describe("db shell resolution (resolveShellDatabase)", () => {
  const client = () => new CreekClient(API, "tok");

  it("--project resolves the single bound D1 without naming it", async () => {
    server.use(
      http.get(`${API}/projects/hivemind/bindings`, () =>
        HttpResponse.json({
          bindings: [
            {
              bindingName: "DB",
              resourceId: "res-d1",
              kind: "database",
              name: "creek-97d8c075",
              status: "active",
              createdAt: 0,
            },
            {
              bindingName: "ASSETS",
              resourceId: "res-r2",
              kind: "storage",
              name: "bucket-1",
              status: "active",
              createdAt: 0,
            },
          ],
        }),
      ),
    );
    const db = await resolveShellDatabase(client(), { project: "hivemind", jsonMode: true });
    expect(db).toEqual({
      id: "res-d1",
      name: "creek-97d8c075",
      project: "hivemind",
      projectSource: "flag",
    });
  });

  it("with no name or --project, infers the project from a wrangler-only directory", async () => {
    const prevCwd = process.cwd();
    const projDir = mkdtempSync(join(tmpdir(), "creek-db-wrangler-test-"));
    writeFileSync(
      join(projDir, "wrangler.toml"),
      'name = "wr-app"\nmain = "src/index.ts"\ncompatibility_date = "2026-01-01"\n',
    );
    process.chdir(projDir);
    try {
      server.use(
        http.get(`${API}/projects/wr-app/bindings`, () =>
          HttpResponse.json({
            bindings: [
              {
                bindingName: "DB",
                resourceId: "res-wr",
                kind: "database",
                name: "creek-wr",
                status: "active",
                createdAt: 0,
              },
            ],
          }),
        ),
      );
      const db = await resolveShellDatabase(client(), { jsonMode: true });
      expect(db).toEqual({
        id: "res-wr",
        name: "creek-wr",
        project: "wr-app",
        projectSource: "wrangler",
      });
    } finally {
      process.chdir(prevCwd);
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it("a malformed wrangler config is invalid_config with the parser's diagnostic, not no_database_specified", async () => {
    const prevCwd = process.cwd();
    const projDir = mkdtempSync(join(tmpdir(), "creek-db-badconfig-test-"));
    writeFileSync(join(projDir, "wrangler.jsonc"), '{ "name": "x", "main": ');
    process.chdir(projDir);
    try {
      const code = await runExit(resolveShellDatabase(client(), { jsonMode: true }));
      expect(code).toBe(1);
      const out = json();
      expect(out).toMatchObject({ ok: false, error: "invalid_config" });
      expect(out.message).toMatch(/^Couldn't read the project config: \S/);
    } finally {
      process.chdir(prevCwd);
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  it("--project with no bound database exits with a structured error", async () => {
    server.use(
      http.get(`${API}/projects/empty/bindings`, () => HttpResponse.json({ bindings: [] })),
    );
    const code = await runExit(
      resolveShellDatabase(client(), { project: "empty", jsonMode: true }),
    );
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "no_database_bound", project: "empty" });
  });

  it("--project with multiple databases exits asking for an explicit name", async () => {
    server.use(
      http.get(`${API}/projects/multi/bindings`, () =>
        HttpResponse.json({
          bindings: [
            {
              bindingName: "DB",
              resourceId: "r1",
              kind: "database",
              name: "db-a",
              status: "active",
              createdAt: 0,
            },
            {
              bindingName: "DB2",
              resourceId: "r2",
              kind: "database",
              name: "db-b",
              status: "active",
              createdAt: 0,
            },
          ],
        }),
      ),
    );
    const code = await runExit(
      resolveShellDatabase(client(), { project: "multi", jsonMode: true }),
    );
    expect(code).toBe(1);
    expect(json()).toMatchObject({
      ok: false,
      error: "ambiguous_database",
      databases: ["db-a", "db-b"],
    });
  });

  it("an explicit name still resolves via listResources", async () => {
    server.use(
      http.get(`${API}/resources`, () =>
        HttpResponse.json({
          resources: [
            {
              id: "res-x",
              teamId: "t",
              kind: "database",
              name: "creek-abc",
              cfResourceId: null,
              cfResourceType: null,
              status: "active",
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        }),
      ),
    );
    const db = await resolveShellDatabase(client(), { name: "creek-abc", jsonMode: true });
    expect(db).toEqual({ id: "res-x", name: "creek-abc" });
  });

  it("a stale/unknown project slug exits with a structured error, not a raw throw", async () => {
    // creek.toml names a project that doesn't exist (renamed/never deployed).
    server.use(
      http.get(`${API}/projects/ghost/bindings`, () =>
        HttpResponse.json({ error: "not_found", message: "project not found" }, { status: 404 }),
      ),
    );
    const code = await runExit(
      resolveShellDatabase(client(), { project: "ghost", jsonMode: true }),
    );
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "project_lookup_failed", project: "ghost" });
  });
});

describe("creek projects delete", () => {
  beforeEach(() => {
    process.env.CREEK_TOKEN = "tok";
  });

  it("deletes a project via DELETE /projects/:slug and reports it", async () => {
    let hit = "";
    server.use(
      http.delete(`${API}/projects/:slug`, ({ params }) => {
        hit = String(params.slug);
        return HttpResponse.json({ ok: true });
      }),
    );
    // Non-TTY auto-confirms (no prompt), matching agent/CI behaviour.
    const code = await runExit(
      projectsCommand.subCommands!.delete.run!({ args: { slug: "ghost", _: [] } } as never),
    );
    expect(code).toBe(0);
    expect(hit).toBe("ghost");
    expect(json()).toMatchObject({ ok: true, project: "ghost", deleted: true });
  });

  it("maps a 404 to a structured not_found error", async () => {
    server.use(
      http.delete(`${API}/projects/:slug`, () =>
        HttpResponse.json({ error: "not_found", message: "nope" }, { status: 404 }),
      ),
    );
    const code = await runExit(
      projectsCommand.subCommands!.delete.run!({ args: { slug: "missing", _: [] } } as never),
    );
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_found", project: "missing" });
  });

  it("bare `creek projects` still lists (parent run doesn't double-fire)", async () => {
    let deleteCalls = 0;
    server.use(
      http.get(`${API}/projects`, () =>
        HttpResponse.json([{ slug: "a", framework: null, production_deployment_id: null }]),
      ),
      http.delete(`${API}/projects/:slug`, () => {
        deleteCalls++;
        return HttpResponse.json({ ok: true });
      }),
    );
    const code = await runExit(projectsCommand.run!({ args: { _: [] }, rawArgs: [] } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, projects: [{ slug: "a" }] });
    expect(deleteCalls).toBe(0);
  });

  it("parent run is a no-op when a subcommand verb is present", async () => {
    // Guards the citty double-run: with rawArgs ["delete","x"] the parent
    // handler must NOT also list (which would hit /projects).
    let listCalls = 0;
    server.use(
      http.get(`${API}/projects`, () => {
        listCalls++;
        return HttpResponse.json([]);
      }),
    );
    await projectsCommand.run!({ args: { _: ["delete"] }, rawArgs: ["delete", "x"] } as never);
    expect(listCalls).toBe(0);
  });
});

describe("creek logs --json (NDJSON)", () => {
  beforeEach(() => {
    process.env.CREEK_TOKEN = "tok";
  });
  const entry = (timestamp: number) => ({
    v: 1,
    timestamp,
    project: "p",
    outcome: "ok",
    logs: [],
    exceptions: [],
  });
  const lines = () =>
    stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("with no entries still prints a summary line, never an empty stdout", async () => {
    server.use(
      http.get(`${API}/projects/p/logs`, () =>
        HttpResponse.json({ entries: [], truncated: false }),
      ),
    );
    await logsCommand.run!({ args: { project: "p", _: [] } } as never);
    expect(lines()).toEqual([
      {
        ok: true,
        type: "summary",
        project: "p",
        projectSource: "flag",
        count: 0,
        truncated: false,
      },
    ]);
  });

  it("prints each entry as a type: entry line, then the summary last", async () => {
    server.use(
      http.get(`${API}/projects/p/logs`, () =>
        HttpResponse.json({ entries: [entry(2), entry(1)], truncated: true }),
      ),
    );
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await logsCommand.run!({ args: { project: "p", _: [] } } as never);
    const out = lines();
    expect(out.map((l) => l.type)).toEqual(["entry", "entry", "summary"]);
    expect(out[0]).toMatchObject({ timestamp: 2, projectSource: "flag" });
    expect(out[2]).toMatchObject({ ok: true, count: 2, truncated: true });
  });
});
