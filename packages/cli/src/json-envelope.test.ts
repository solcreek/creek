import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import consola from "consola";
import { withEnvelope } from "./utils/output.js";
import { statusCommand } from "./commands/status.js";
import { deploymentsCommand } from "./commands/deployments.js";
import { doctorCommand } from "./commands/doctor.js";
import { logsCommand } from "./commands/logs.js";
import { metricsCommand } from "./commands/metrics.js";
import { dbCommand } from "./commands/db.js";
import { storageCommand } from "./commands/storage.js";
import { cacheCommand } from "./commands/cache.js";
import { opsCommand } from "./commands/ops.js";
import { verifyCommand } from "./commands/verify.js";
import { rollbackCommand } from "./commands/rollback.js";
import { projectsCommand } from "./commands/projects.js";
import { queueCommand } from "./commands/queue.js";

// Every `--json` result is one envelope: `ok: boolean`, and on a failure also
// `error` and `message` (skills/creek/references/commands.md). Commands print
// it only through jsonOutput / jsonLine (utils/output.ts). Fabricated IDs only.

const SRC = import.meta.dirname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const path = join(dir, f);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return f.endsWith(".ts") && !/\.test(-d)?\.ts$/.test(f) ? [path] : [];
  });
}

describe("JSON reaches stdout only through the shared output helpers", () => {
  // Printing JSON by hand skips the envelope (and, in a command that reserved
  // stdout, the guard): route it through jsonOutput (one document) or jsonLine
  // (NDJSON).
  const PRINTS_JSON =
    /\b(process\.stdout\.write|console\.(log|info)|consola\.(log|info|success|warn|box))\(\s*JSON\.stringify\(/g;

  it("no source file but utils/output.ts writes JSON.stringify output to stdout", () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !f.endsWith(join("utils", "output.ts")))
      .flatMap((f) => {
        const src = readFileSync(f, "utf-8");
        return [...src.matchAll(PRINTS_JSON)].map(
          (m) => `${relative(SRC, f)}:${src.slice(0, m.index).split("\n").length}`,
        );
      });
    expect(offenders).toEqual([]);
  });
});

describe("withEnvelope", () => {
  it("fills in ok from the exit code, and error and message on a failure", () => {
    expect(withEnvelope({ url: "x" }, 0)).toEqual({ ok: true, url: "x" });
    expect(withEnvelope({ error: "not_found" }, 1)).toEqual({
      ok: false,
      error: "not_found",
      message: "not_found",
    });
    expect(withEnvelope({}, 1)).toMatchObject({ ok: false, error: "command_failed" });
  });

  it("keeps what the command said, and puts ok first", () => {
    const out = withEnvelope({ checks: {}, ok: false, error: "unhealthy", message: "m" }, 0);
    expect(out).toEqual({ ok: false, checks: {}, error: "unhealthy", message: "m" });
    expect(Object.keys(out)[0]).toBe("ok");
  });
});

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}

type Sub = Record<string, { run?: (ctx: never) => unknown }>;
const run =
  (command: { run?: unknown; subCommands?: unknown }, name?: string) =>
  (args: Record<string, unknown>) =>
  () => {
    const target = name ? (command.subCommands as Sub)[name] : command;
    return (target.run as (ctx: never) => unknown)({
      args: { _: [], json: true, ...args },
      rawArgs: [],
    } as never);
  };

interface Row {
  name: string;
  run: () => unknown;
  /** Answers every request; default: none expected. */
  fetch?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
  authenticated?: boolean;
}

const API = "https://cp.test";
const project = { project: "demo" };

const ROWS: Row[] = [
  // A signed-out run: every command that needs a key says so the same way.
  { name: "status", run: run(statusCommand)(project) },
  { name: "deployments", run: run(deploymentsCommand, "list")(project) },
  { name: "deployments logs", run: run(deploymentsCommand, "logs")({ ...project, id: "dep1" }) },
  { name: "doctor --last", run: run(doctorCommand)({ ...project, last: true }) },
  { name: "logs", run: run(logsCommand)(project) },
  { name: "metrics", run: run(metricsCommand)(project) },
  { name: "db shell", run: run(dbCommand, "shell")({ ...project, sql: "select 1" }) },
  { name: "db migrate", run: run(dbCommand, "migrate")(project) },
  { name: "db seed", run: run(dbCommand, "seed")(project) },
  { name: "db ls", run: run(dbCommand, "ls")({}) },
  { name: "storage ls", run: run(storageCommand, "ls")({}) },
  { name: "cache ls", run: run(cacheCommand, "ls")({}) },
  { name: "projects", run: run(projectsCommand, "list")({}) },
  { name: "queue send", run: run(queueCommand, "send")({ ...project, message: "{}" }) },
  // Results that left out ok, error or message.
  {
    name: "doctor (issues found)",
    run: () => run(doctorCommand)({ path: mkdtempSync(join(tmpdir(), "creek-doctor-")) })(),
  },
  { name: "ops bogus", run: run(opsCommand)({ sub: "bogus" }), authenticated: true },
  {
    name: "ops health (a service down)",
    run: run(opsCommand)({ sub: "health" }),
    fetch: () => {
      throw new TypeError("fetch failed");
    },
  },
  {
    name: "ops health (all up)",
    run: run(opsCommand)({ sub: "health" }),
    fetch: (url) => new Response(null, { status: url.hostname === "cp.test" ? 404 : 400 }),
  },
  { name: "verify (bad URL)", run: run(verifyCommand)({ url: "ftp://x" }) },
  {
    name: "verify (HTTP 500)",
    run: run(verifyCommand)({ url: "https://site.test/" }),
    fetch: () => new Response("down", { status: 500 }),
  },
  {
    name: "rollback",
    run: run(rollbackCommand)(project),
    authenticated: true,
    // The API's own answer: no `ok` of its own needed.
    fetch: () =>
      Response.json({
        deploymentId: "dep3",
        rolledBackTo: "dep1",
        previousDeploymentId: "dep2",
        url: "https://demo.test",
      }),
  },
];

const realFetch = globalThis.fetch;
let stdout: string;

beforeEach(() => {
  stdout = "";
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const level of ["error", "info", "warn", "log", "success"] as const) {
    vi.spyOn(consola, level).mockImplementation(() => {});
  }
  process.env.CREEK_API_URL = API;
});
afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  delete process.env.CREEK_API_URL;
  delete process.env.CREEK_TOKEN;
});

describe.each(ROWS)("$name --json", (row) => {
  it("prints one envelope: ok, and error and message on a failure", async () => {
    // "" (not unset): getToken() would otherwise read the developer's config.
    process.env.CREEK_TOKEN = row.authenticated ? "tok" : "";
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!row.fetch) throw new Error(`unexpected request ${url}`);
      return row.fetch(url, init);
    }) as typeof fetch;

    let code: number | undefined;
    try {
      await row.run();
    } catch (err) {
      if (!(err instanceof ExitSignal)) throw err;
      code = err.code;
    }
    const out = JSON.parse(stdout) as Record<string, unknown>;
    expect(typeof out.ok).toBe("boolean");
    expect(code ?? 0).toBe(out.ok ? 0 : 1);
    if (!out.ok) {
      expect(out.error).toEqual(expect.any(String));
      expect(out.message).toEqual(expect.any(String));
      // A sentence for a person, not the floor withEnvelope fills in.
      expect(out.message).not.toBe(out.error);
    }
  });
});
