import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { envCommand } from "./env.js";

// Drive `creek env set/rm` against MSW. Tests run non-TTY, so resolveJsonMode
// is true and the commands emit JSON (with breadcrumbs) before exiting — that
// JSON path is what an AI agent reads, so we assert the redeploy guidance is
// present there. The human-readable `consola.info` hint runs only under a real
// TTY and isn't exercised here. Fabricated IDs only.
const API = "https://cp.test";
const SLUG = "myproj";

const setCmd = (
  envCommand.subCommands as Record<string, { run?: (ctx: never) => Promise<unknown> }>
).set;
const rmCmd = (envCommand.subCommands as Record<string, { run?: (ctx: never) => Promise<unknown> }>)
  .rm;

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
let testDir: string;
let prevCwd: string;
beforeEach(() => {
  stdout = "";
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  process.env.CREEK_API_URL = API;
  process.env.CREEK_TOKEN = "tok-test";

  // getProjectSlug() reads creek.toml from the current working directory.
  testDir = join(tmpdir(), `creek-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, "creek.toml"), `[project]\nname = "${SLUG}"\n`);
  prevCwd = process.cwd();
  process.chdir(testDir);
});
afterEach(() => {
  process.chdir(prevCwd);
  vi.restoreAllMocks();
  delete process.env.CREEK_API_URL;
  delete process.env.CREEK_TOKEN;
  rmSync(testDir, { recursive: true, force: true });
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
function json() {
  return JSON.parse(stdout);
}
function hasDeployBreadcrumb(): boolean {
  const out = json();
  return (
    Array.isArray(out.breadcrumbs) &&
    out.breadcrumbs.some((b: { command: string }) => b.command.startsWith("creek deploy"))
  );
}

describe("creek env set", () => {
  it("dry-run does not POST and still reports pendingDeploy", async () => {
    let posted = false;
    server.use(
      http.post(`${API}/projects/${SLUG}/env`, () => {
        posted = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const code = await runExit(
      setCmd.run!({
        args: { key: "DATABASE_URL", value: "postgres://x", "dry-run": true },
      } as never),
    );
    expect(code).toBe(0);
    expect(posted).toBe(false);
    expect(json()).toMatchObject({
      ok: true,
      mode: "dry-run",
      wouldExecute: true,
      key: "DATABASE_URL",
      pendingDeploy: true,
    });
    expect(json().nextStep).toBe("creek env set DATABASE_URL '$VALUE' --json");
    expect(json().sideEffects).toContain(
      "Replace $VALUE with the real secret; keep the single quotes",
    );
  });

  it("sets the variable and tells the user a deploy is needed to apply it", async () => {
    let body: { key: string; value: string } | null = null;
    server.use(
      http.post(`${API}/projects/${SLUG}/env`, async ({ request }) => {
        body = (await request.json()) as { key: string; value: string };
        return HttpResponse.json({ ok: true, key: body.key });
      }),
    );

    const code = await runExit(
      setCmd.run!({ args: { key: "DATABASE_URL", value: "postgres://x" } } as never),
    );

    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, key: "DATABASE_URL", project: SLUG });
    expect(body).toEqual({ key: "DATABASE_URL", value: "postgres://x" });
    // The redeploy guidance must be present so a set doesn't look like it took
    // effect immediately.
    expect(hasDeployBreadcrumb()).toBe(true);
  });
});

describe("creek env rm", () => {
  it("dry-run GETs the list and does not DELETE", async () => {
    let deleted = false;
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json([{ key: "OLD_KEY", value: "secret" }]),
      ),
      http.delete(`${API}/projects/${SLUG}/env/OLD_KEY`, () => {
        deleted = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const code = await runExit(rmCmd.run!({ args: { key: "OLD_KEY", "dry-run": true } } as never));
    expect(code).toBe(0);
    expect(deleted).toBe(false);
    expect(json()).toMatchObject({
      ok: true,
      mode: "dry-run",
      wouldExecute: true,
      key: "OLD_KEY",
    });
  });

  it("dry-run wouldExecute is false when the key is missing", async () => {
    server.use(http.get(`${API}/projects/${SLUG}/env`, () => HttpResponse.json([])));
    const code = await runExit(rmCmd.run!({ args: { key: "MISSING", "dry-run": true } } as never));
    expect(code).toBe(0);
    expect(json()).toMatchObject({ wouldExecute: false, exists: false });
  });

  it("removes the variable and surfaces the redeploy guidance", async () => {
    server.use(
      http.delete(`${API}/projects/${SLUG}/env/OLD_KEY`, () => HttpResponse.json({ ok: true })),
    );

    const code = await runExit(rmCmd.run!({ args: { key: "OLD_KEY" } } as never));

    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, key: "OLD_KEY", removed: true });
    expect(hasDeployBreadcrumb()).toBe(true);
  });
});

describe("creek env rm, run twice", () => {
  type Row = { key: string; target: string };
  let rows: Row[];
  let deletes: number;
  let lists: number;

  // A server with targets: deletes the matching rows, and 404s with
  // `missing: "envvar"` when there are none — like the control-plane.
  function liveServer() {
    rows = [
      { key: "OLD_KEY", target: "all" },
      { key: "STRIPE_KEY", target: "production" },
    ];
    deletes = 0;
    lists = 0;
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () => {
        lists++;
        return HttpResponse.json(rows.map((r) => ({ ...r, value: "XXXX****" })));
      }),
      http.delete(`${API}/projects/${SLUG}/env/:key`, ({ request, params }) => {
        deletes++;
        const target = new URL(request.url).searchParams.get("target");
        const hit = (r: Row) => r.key === params.key && (!target || r.target === target);
        const removed = rows.filter(hit).length;
        rows = rows.filter((r) => !hit(r));
        if (!removed)
          return HttpResponse.json(
            {
              error: "not_found",
              missing: "envvar",
              key: params.key,
              ...(target ? { target } : {}),
              message: "Environment variable not found",
            },
            { status: 404 },
          );
        return HttpResponse.json({ ok: true, removed });
      }),
    );
  }

  it("a second rm of the same key succeeds with alreadyAbsent", async () => {
    liveServer();
    expect(await runExit(rmCmd.run!({ args: { key: "OLD_KEY" } } as never))).toBe(0);
    expect(json()).toMatchObject({ ok: true, alreadyAbsent: false, removed: true });

    stdout = "";
    expect(await runExit(rmCmd.run!({ args: { key: "OLD_KEY" } } as never))).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      key: "OLD_KEY",
      alreadyAbsent: true,
      removed: false,
      removedValues: 0,
      project: SLUG,
      // An earlier run that timed out may have removed it undeployed.
      pendingDeploy: true,
    });
    expect(json().message).toContain("nothing was removed");
    expect(hasDeployBreadcrumb()).toBe(true);
    // The API's own 404 said the key is missing: no list needed.
    expect(lists).toBe(0);
    expect(deletes).toBe(2);
  });

  it("a key that can't exist (padded, lowercase) is invalid_key, not alreadyAbsent", async () => {
    liveServer();
    for (const key of [" OLD_KEY", "OLD_KEY ", "old_key"]) {
      stdout = "";
      expect(await runExit(rmCmd.run!({ args: { key } } as never)), key).toBe(1);
      expect(json()).toMatchObject({ ok: false, error: "invalid_key", key });
      expect(json().alreadyAbsent).toBeUndefined();
    }
    // Nothing was sent, and the real key is still set.
    expect(deletes).toBe(0);
    expect(rows.some((r) => r.key === "OLD_KEY")).toBe(true);
  });

  it("`unset` re-run behaves the same", async () => {
    liveServer();
    const unset = (
      envCommand.subCommands as Record<string, { run?: (ctx: never) => Promise<unknown> }>
    ).unset;
    expect(await runExit(unset.run!({ args: { key: "OLD_KEY" } } as never))).toBe(0);
    stdout = "";
    expect(await runExit(unset.run!({ args: { key: "OLD_KEY" } } as never))).toBe(0);
    expect(json()).toMatchObject({ ok: true, alreadyAbsent: true });
  });

  it("a --target whose value is gone is alreadyAbsent, the others stay", async () => {
    liveServer();
    const args = { key: "STRIPE_KEY", target: "production" };
    expect(await runExit(rmCmd.run!({ args } as never))).toBe(0);
    expect(json()).toMatchObject({ ok: true, target: "production", alreadyAbsent: false });
    stdout = "";
    expect(await runExit(rmCmd.run!({ args } as never))).toBe(0);
    expect(json()).toMatchObject({ ok: true, target: "production", alreadyAbsent: true });
  });

  it("an older API's bare 404 counts only when the project's list loads without the key", async () => {
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json([{ key: "OTHER", target: "all", value: "OTHE****" }]),
      ),
      http.delete(`${API}/projects/${SLUG}/env/GONE`, () =>
        HttpResponse.json(
          { error: "not_found", message: "Environment variable 'GONE' not found" },
          { status: 404 },
        ),
      ),
    );
    expect(await runExit(rmCmd.run!({ args: { key: "GONE" } } as never))).toBe(0);
    expect(json()).toMatchObject({ ok: true, alreadyAbsent: true });
  });

  it("an older API's bare 404 with the key set again by then is an error, not alreadyAbsent", async () => {
    // Another process re-sets the key after this DELETE missed it: the
    // follow-up list shows it, so it is not reported as absent.
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json([{ key: "GONE", target: "all", value: "GONE****" }]),
      ),
      http.delete(`${API}/projects/${SLUG}/env/GONE`, () =>
        HttpResponse.json({ error: "not_found", message: "not found" }, { status: 404 }),
      ),
    );
    expect(await runExit(rmCmd.run!({ args: { key: "GONE" } } as never))).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "rm_failed", status: 404 });
  });

  it("a missing project is still an error", async () => {
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json({ error: "not_found", message: "Project not found" }, { status: 404 }),
      ),
      http.delete(`${API}/projects/${SLUG}/env/ANY`, () =>
        HttpResponse.json({ error: "not_found", message: "Project not found" }, { status: 404 }),
      ),
    );
    expect(await runExit(rmCmd.run!({ args: { key: "ANY" } } as never))).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "rm_failed", status: 404 });
    expect(json().alreadyAbsent).toBeUndefined();
  });

  it("an older API's bare 404 with an unreadable list is an error, not alreadyAbsent", async () => {
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json({ error: "insufficient_scope", required: ["env:read"] }, { status: 403 }),
      ),
      http.delete(`${API}/projects/${SLUG}/env/GONE`, () =>
        HttpResponse.json({ error: "not_found", message: "not found" }, { status: 404 }),
      ),
    );
    expect(await runExit(rmCmd.run!({ args: { key: "GONE" } } as never))).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "rm_failed" });
  });

  it("--dry-run on a key that is not set says alreadyAbsent", async () => {
    liveServer();
    expect(await runExit(rmCmd.run!({ args: { key: "NOPE", "dry-run": true } } as never))).toBe(0);
    expect(json()).toMatchObject({ wouldExecute: false, exists: false, alreadyAbsent: true });
    expect(deletes).toBe(0);
  });
});

const lsCmd = (envCommand.subCommands as Record<string, { run?: (ctx: never) => Promise<unknown> }>)
  .ls;

describe("creek env --target", () => {
  it("sends --target to the server and reports it", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${API}/projects/${SLUG}/env`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { ok: true, key: "STRIPE_KEY", target: "production" },
          { status: 201 },
        );
      }),
    );
    const code = await runExit(
      setCmd.run!({ args: { key: "STRIPE_KEY", value: "sk_live", target: "production" } } as never),
    );
    expect(code).toBe(0);
    expect(body).toEqual({ key: "STRIPE_KEY", value: "sk_live", target: "production" });
    expect(json()).toMatchObject({ ok: true, key: "STRIPE_KEY", target: "production" });
    // Breadcrumbs name only commands that exist (env ls takes no --project).
    for (const b of json().breadcrumbs) expect(b.command).not.toContain("--project");
  });

  it("omits target for all, so servers without targets keep working", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${API}/projects/${SLUG}/env`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, key: "A" }, { status: 201 });
      }),
    );
    expect(await runExit(setCmd.run!({ args: { key: "A", value: "v" } } as never))).toBe(0);
    expect(body).toEqual({ key: "A", value: "v" });
    expect(json()).toMatchObject({ ok: true, target: "all" });
  });

  it("warns about production, not previews, when a preview value was stored for all deploys", async () => {
    server.use(
      http.post(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json({ ok: true, key: "STRIPE_KEY" }, { status: 201 }),
      ),
    );
    const code = await runExit(
      setCmd.run!({ args: { key: "STRIPE_KEY", value: "sk_test", target: "preview" } } as never),
    );
    expect(code).toBe(1);
    expect(json().message).toContain("Production deploys now get this preview value");
  });

  it("refuses rm --target on a server without targets instead of deleting the all value", async () => {
    let deleted = false;
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json([{ key: "STRIPE_KEY", value: "STRI****" }]),
      ),
      http.delete(`${API}/projects/${SLUG}/env/STRIPE_KEY`, () => {
        deleted = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const code = await runExit(
      rmCmd.run!({ args: { key: "STRIPE_KEY", target: "production" } } as never),
    );
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "target_unsupported" });
    expect(deleted).toBe(false);
  });

  it("still removes a per-target value when the key may not list (env:write without env:read)", async () => {
    let deletedUrl = "";
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json({ error: "insufficient_scope", required: ["env:read"] }, { status: 403 }),
      ),
      http.delete(`${API}/projects/${SLUG}/env/STRIPE_KEY`, ({ request }) => {
        deletedUrl = request.url;
        return HttpResponse.json({ ok: true, removed: 1 });
      }),
    );
    const code = await runExit(
      rmCmd.run!({ args: { key: "STRIPE_KEY", target: "preview" } } as never),
    );
    expect(code).toBe(0);
    expect(new URL(deletedUrl).searchParams.get("target")).toBe("preview");
  });

  it("does not delete when the list fails for any reason other than scope", async () => {
    let deleted = false;
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json({ error: "internal", message: "boom" }, { status: 500 }),
      ),
      http.delete(`${API}/projects/${SLUG}/env/STRIPE_KEY`, () => {
        deleted = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const code = await runExit(
      rmCmd.run!({ args: { key: "STRIPE_KEY", target: "production" } } as never),
    );
    expect(code).toBe(1);
    expect(deleted).toBe(false);
  });

  it("refuses to report success when the server ignored the target", async () => {
    server.use(
      http.post(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json({ ok: true, key: "STRIPE_KEY" }, { status: 201 }),
      ),
    );
    const code = await runExit(
      setCmd.run!({ args: { key: "STRIPE_KEY", value: "sk_live", target: "production" } } as never),
    );
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "target_unsupported", key: "STRIPE_KEY" });
    expect(json().message).toContain("creek env rm STRIPE_KEY");
  });

  it("rejects an unknown target before any request", async () => {
    for (const target of ["staging", "Production"]) {
      stdout = "";
      const code = await runExit(setCmd.run!({ args: { key: "A", value: "v", target } } as never));
      expect(code, target).toBe(1);
      expect(json()).toMatchObject({ ok: false, error: "invalid_target" });
    }
  });

  it("lists the target of each value", async () => {
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json([
          { key: "K", target: "all", value: "K***" },
          { key: "K", target: "production", value: "K***" },
          { key: "OLD", value: "OLD***" },
        ]),
      ),
    );
    expect(await runExit(lsCmd.run!({ args: {} } as never))).toBe(0);
    expect(json().vars.map((v: { key: string; target: string }) => [v.key, v.target])).toEqual([
      ["K", "all"],
      ["K", "production"],
      ["OLD", "all"],
    ]);
  });

  it("removes one target's value with --target, and says which values a dry run would remove", async () => {
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json([
          { key: "K", target: "all", value: "K***" },
          { key: "K", target: "preview", value: "K***" },
        ]),
      ),
    );
    expect(await runExit(rmCmd.run!({ args: { key: "K", "dry-run": true } } as never))).toBe(0);
    expect(json()).toMatchObject({ exists: true, targets: ["all", "preview"] });

    stdout = "";
    expect(
      await runExit(
        rmCmd.run!({ args: { key: "K", target: "production", "dry-run": true } } as never),
      ),
    ).toBe(0);
    expect(json()).toMatchObject({ exists: false, targets: [], wouldExecute: false });

    let url = "";
    server.use(
      http.delete(`${API}/projects/${SLUG}/env/K`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ ok: true, removed: 1 });
      }),
    );
    stdout = "";
    expect(await runExit(rmCmd.run!({ args: { key: "K", target: "preview" } } as never))).toBe(0);
    expect(new URL(url).searchParams.get("target")).toBe("preview");
    expect(json()).toMatchObject({ ok: true, key: "K", target: "preview", removedValues: 1 });
  });
});

describe("creek env ls: values are write-only", () => {
  it("lists keys and targets and no value field", async () => {
    // The API's `value` is mask(key) — the key name masked, not the secret.
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () =>
        HttpResponse.json([{ key: "DATABASE_URL", target: "all", value: "DATA****" }]),
      ),
    );
    expect(await runExit(lsCmd.run!({ args: {} } as never))).toBe(0);
    expect(json()).toMatchObject({ ok: true, valuesWriteOnly: true });
    expect(json().vars).toEqual([{ key: "DATABASE_URL", target: "all" }]);
  });

  it("--show refuses with values_write_only instead of printing a placeholder", async () => {
    let listed = false;
    server.use(
      http.get(`${API}/projects/${SLUG}/env`, () => {
        listed = true;
        return HttpResponse.json([{ key: "DATABASE_URL", target: "all", value: "DATA****" }]);
      }),
    );
    expect(await runExit(lsCmd.run!({ args: { show: true } } as never))).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "values_write_only" });
    expect(json().message).toContain("write-only");
    expect(stdout).not.toContain("DATA****");
    expect(listed).toBe(false);
  });
});
