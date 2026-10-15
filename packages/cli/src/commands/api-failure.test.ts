import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import consola from "consola";
import { installRequestLedger, resetRequestLedger } from "../utils/request-ledger.js";
import { projectsCommand } from "./projects.js";
import { dbCommand } from "./db.js";
import { storageCommand } from "./storage.js";
import { cacheCommand } from "./cache.js";
import { domainsCommand } from "./domains.js";
import { envCommand } from "./env.js";
import { rollbackCommand } from "./rollback.js";

// Every command that wraps its API calls in apiCall (utils/command-context.ts)
// must report a failed call in the CLI runner's shape: a network failure is
// `api_unreachable` with `reason`, `retryable` and `mayHaveApplied`; an API
// refusal keeps the command's own `error` and adds `status`, `apiError` and
// `details`. Each row fails one request (`fail`) and answers the others from
// CANNED. Fabricated IDs only.

const API = "https://cp.test";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}

type Sub = Record<string, { run?: (ctx: never) => unknown }>;
function sub(command: { subCommands?: unknown }, name: string) {
  return (args: Record<string, unknown>) =>
    (command.subCommands as Sub)[name].run!({ args: { _: [], ...args } } as never);
}

/** Answers for the requests a row does not fail, by `METHOD pathname`. */
const CANNED: Record<string, unknown> = {
  "GET /projects": [{ id: "p1", slug: "demo" }],
  "GET /projects/demo": { id: "p1", slug: "demo", productionDeploymentId: "dep2" },
  "GET /projects/demo/deployments": [],
  "GET /projects/demo/rollback": {
    currentDeploymentId: "dep2",
    targetDeploymentId: "dep1",
    targetStatus: "active",
  },
  "GET /resources": {
    resources: [
      { id: "r1", name: "main", kind: "database", status: "active" },
      { id: "r2", name: "main", kind: "storage", status: "active" },
      { id: "r3", name: "main", kind: "cache", status: "active" },
    ],
  },
  "GET /resources/r1": { id: "r1", name: "main", kind: "database", bindings: [] },
  "GET /projects/demo/domains": [{ id: "d1", hostname: "a.example.com", status: "pending" }],
  "GET /projects/demo/env": [{ key: "K", target: "production" }],
};

interface Row {
  /** The command, as an agent types it. */
  name: string;
  /** The command file, for the coverage check below. */
  file: string;
  run: () => Promise<unknown>;
  /** The request this row fails: `METHOD pathname`. */
  fail: string;
  /** The command's own error code for an API refusal. */
  code: string;
}

const ROWS: Row[] = [
  {
    name: "projects list",
    file: "projects.ts",
    run: () => sub(projectsCommand, "list")({}),
    fail: "GET /projects",
    code: "api_error",
  },
  {
    name: "projects delete demo",
    file: "projects.ts",
    run: () => sub(projectsCommand, "delete")({ slug: "demo", yes: true }),
    fail: "DELETE /projects/demo",
    code: "delete_failed",
  },
  ...(
    [
      ["db", dbCommand],
      ["storage", storageCommand],
      ["cache", cacheCommand],
    ] as const
  ).map(([cmd, command]) => ({
    name: `${cmd} ls`,
    file: "resource-cmd.ts",
    run: () => sub(command, "ls")({}),
    fail: "GET /resources",
    code: "api_error",
  })),
  {
    name: "db attach main --to demo",
    file: "resource-cmd.ts",
    run: () => sub(dbCommand, "attach")({ name: "main", to: "demo" }),
    fail: "GET /resources",
    code: "api_error",
  },
  {
    name: "db rename main --to other",
    file: "resource-cmd.ts",
    run: () => sub(dbCommand, "rename")({ name: "main", to: "other" }),
    fail: "GET /resources",
    code: "api_error",
  },
  {
    name: "db delete main",
    file: "resource-cmd.ts",
    run: () => sub(dbCommand, "delete")({ name: "main" }),
    fail: "GET /resources",
    code: "api_error",
  },
  {
    name: "db delete main --dry-run",
    file: "resource-cmd.ts",
    run: () => sub(dbCommand, "delete")({ name: "main", "dry-run": true }),
    fail: "GET /resources/r1",
    code: "api_error",
  },
  {
    name: "domains ls",
    file: "domains.ts",
    run: () => sub(domainsCommand, "ls")({ project: "demo" }),
    fail: "GET /projects/demo/domains",
    code: "api_error",
  },
  {
    name: "domains add b.example.com",
    file: "domains.ts",
    run: () => sub(domainsCommand, "add")({ hostname: "b.example.com", project: "demo" }),
    fail: "POST /projects/demo/domains",
    code: "add_failed",
  },
  {
    name: "domains show a.example.com",
    file: "domains.ts",
    run: () => sub(domainsCommand, "show")({ hostname: "a.example.com", project: "demo" }),
    fail: "GET /projects/demo/domains/d1",
    code: "api_error",
  },
  {
    name: "domains rm a.example.com",
    file: "domains.ts",
    run: () => sub(domainsCommand, "rm")({ hostname: "a.example.com", project: "demo" }),
    fail: "DELETE /projects/demo/domains/d1",
    code: "delete_failed",
  },
  {
    name: "domains activate a.example.com",
    file: "domains.ts",
    run: () => sub(domainsCommand, "activate")({ hostname: "a.example.com", project: "demo" }),
    fail: "POST /projects/demo/domains/d1/activate",
    code: "activate_failed",
  },
  {
    name: "env set K V",
    file: "env.ts",
    run: () => sub(envCommand, "set")({ key: "K", value: "V", project: "demo" }),
    fail: "POST /projects/demo/env",
    code: "set_failed",
  },
  {
    name: "env ls",
    file: "env.ts",
    run: () => sub(envCommand, "ls")({ project: "demo" }),
    fail: "GET /projects/demo/env",
    code: "api_error",
  },
  {
    name: "env rm K --dry-run",
    file: "env.ts",
    run: () => sub(envCommand, "rm")({ key: "K", project: "demo", "dry-run": true }),
    fail: "GET /projects/demo/env",
    code: "api_error",
  },
  {
    name: "env rm K --target production",
    file: "env.ts",
    run: () => sub(envCommand, "rm")({ key: "K", target: "production", project: "demo" }),
    fail: "GET /projects/demo/env",
    code: "api_error",
  },
  {
    name: "env rm K",
    file: "env.ts",
    run: () => sub(envCommand, "rm")({ key: "K", project: "demo" }),
    fail: "DELETE /projects/demo/env/K",
    code: "rm_failed",
  },
  {
    name: "rollback --dry-run (project)",
    file: "rollback.ts",
    run: () => rollbackCommand.run!({ args: { _: [], project: "demo", "dry-run": true } } as never),
    fail: "GET /projects/demo",
    code: "api_error",
  },
  {
    name: "rollback --dry-run (plan)",
    file: "rollback.ts",
    run: () => rollbackCommand.run!({ args: { _: [], project: "demo", "dry-run": true } } as never),
    fail: "GET /projects/demo/rollback",
    code: "api_error",
  },
  {
    name: "rollback dep1 --dry-run (list)",
    file: "rollback.ts",
    run: () =>
      rollbackCommand.run!({
        args: { _: [], deployment: "dep1", project: "demo", "dry-run": true },
      } as never),
    fail: "GET /projects/demo/deployments",
    code: "api_error",
  },
  {
    name: "rollback dep1 --dry-run (lookup)",
    file: "rollback.ts",
    run: () =>
      rollbackCommand.run!({
        args: { _: [], deployment: "dep1", project: "demo", "dry-run": true },
      } as never),
    fail: "GET /projects/demo/deployments/dep1",
    code: "api_error",
  },
  {
    name: "rollback",
    file: "rollback.ts",
    run: () => rollbackCommand.run!({ args: { _: [], project: "demo" } } as never),
    fail: "POST /projects/demo/rollback",
    code: "rollback_failed",
  },
];

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const isWrite = (row: Row) => !SAFE.has(row.fail.split(" ")[0]);

type Failure = (req: string) => Promise<Response>;
const realFetch = globalThis.fetch;
let stdout: string;
let requests: string[];

/** Route every request: the row's failing one through `failure`, the rest to CANNED. */
function stubFetch(fail: string, failure: Failure) {
  requests = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    requests.push(key);
    if (key === fail) return failure(key);
    if (key in CANNED) return Response.json(CANNED[key]);
    if (key.startsWith("GET ")) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ ok: true });
  }) as typeof fetch;
  // Count this run's writes the way the CLI does (index.ts).
  installRequestLedger();
}

async function runJson(row: Row): Promise<Record<string, unknown>> {
  try {
    await row.run();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    expect(err.code).toBe(1);
    expect(requests).toContain(row.fail);
    return JSON.parse(stdout) as Record<string, unknown>;
  }
  throw new Error(`${row.name}: expected process.exit (requests: ${requests.join(", ")})`);
}

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
  for (const level of ["error", "info", "warn", "log", "success"] as const) {
    vi.spyOn(consola, level).mockImplementation(() => {});
  }
  process.env.CREEK_API_URL = API;
  process.env.CREEK_TOKEN = "tok";
});
afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  resetRequestLedger();
  delete process.env.CREEK_API_URL;
  delete process.env.CREEK_TOKEN;
});

describe.each(ROWS)("$name: a failed API call", (row) => {
  it("a network failure is api_unreachable, with reason, retryable and mayHaveApplied", async () => {
    stubFetch(row.fail, async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      });
    });
    const out = await runJson(row);
    expect(out).toMatchObject({ ok: false, error: "api_unreachable", reason: "ECONNRESET" });
    if (isWrite(row)) {
      // The write may have reached the server: check before re-running.
      expect(out).toMatchObject({ retryable: false, mayHaveApplied: true });
      expect(out.message).toContain("Check the result");
    } else {
      expect(out).toMatchObject({ retryable: true });
      expect(out).not.toHaveProperty("mayHaveApplied");
      expect(out.message).toContain("retry");
    }
    expect(out).not.toHaveProperty("status");
  });

  it("a 409 keeps the command's error code, with apiError and details", async () => {
    stubFetch(row.fail, async () =>
      Response.json(
        { error: "conflict", message: "Already taken", existing: { id: "x1" } },
        { status: 409 },
      ),
    );
    const out = await runJson(row);
    expect(out).toMatchObject({
      ok: false,
      error: row.code,
      message: "Already taken",
      status: 409,
      apiError: "conflict",
      details: { existing: { id: "x1" } },
    });
    expect(out).not.toHaveProperty("retryable");
  });

  it("a 500 keeps the command's error code, with status and apiError", async () => {
    stubFetch(row.fail, async () =>
      Response.json({ error: "internal", message: "Server exploded" }, { status: 500 }),
    );
    const out = await runJson(row);
    expect(out).toMatchObject({
      ok: false,
      error: row.code,
      message: "Server exploded",
      status: 500,
      apiError: "internal",
    });
  });
});

it("every command file that calls apiCall has a row above", () => {
  const dir = import.meta.dirname;
  const users = readdirSync(dir).filter(
    (f) =>
      f.endsWith(".ts") &&
      !f.includes(".test.") &&
      /\bapiCall\(/.test(readFileSync(join(dir, f), "utf-8")),
  );
  const covered = new Set(ROWS.map((r) => r.file));
  expect(users.filter((f) => !covered.has(f))).toEqual([]);
});
