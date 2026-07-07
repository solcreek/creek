import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreekClient } from "@solcreek/sdk";
import { statusCommand } from "./status.js";
import { opsCommand } from "./ops.js";
import { claimCommand } from "./claim.js";
import { envCommand } from "./env.js";
import { resolveShellDatabase } from "./db.js";
import { projectsCommand } from "./projects.js";

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
    expect(db).toEqual({ id: "res-d1", name: "creek-97d8c075" });
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
