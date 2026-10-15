import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArgsDef, CommandDef } from "citty";
import { NO_PROJECT_MESSAGE, projectFromDirectory, resolveProjectSlug } from "./command-context.js";
import { envCommand } from "../commands/env.js";
import { deploymentsCommand } from "../commands/deployments.js";
import { domainsCommand } from "../commands/domains.js";
import { queueCommand } from "../commands/queue.js";
import { logsCommand } from "../commands/logs.js";
import { metricsCommand } from "../commands/metrics.js";
import { rollbackCommand } from "../commands/rollback.js";
import { statusCommand } from "../commands/status.js";
import { dbCommand } from "../commands/db.js";
import { doctorCommand } from "../commands/doctor.js";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}

let dir: string;
let prevCwd: string;
let stdout: string;
beforeEach(() => {
  prevCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "creek-project-resolution-"));
  process.chdir(dir);
  stdout = "";
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

function exitCode(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
  throw new Error("expected process.exit");
}

const CREEK_TOML = '[project]\nname = "from-creek-toml"\n';
const WRANGLER_JSONC = `{
  // comments are allowed
  "name": "from-wrangler",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
}
`;

describe("resolveProjectSlug order", () => {
  it("--project wins over creek.toml and the wrangler config", () => {
    writeFileSync(join(dir, "creek.toml"), CREEK_TOML);
    writeFileSync(join(dir, "wrangler.jsonc"), WRANGLER_JSONC);
    expect(resolveProjectSlug("explicit", true)).toBe("explicit");
  });

  it("creek.toml wins over the wrangler config", () => {
    writeFileSync(join(dir, "creek.toml"), CREEK_TOML);
    writeFileSync(join(dir, "wrangler.jsonc"), WRANGLER_JSONC);
    expect(resolveProjectSlug(undefined, true)).toBe("from-creek-toml");
  });

  it("uses the wrangler.jsonc name when there is no creek.toml", () => {
    writeFileSync(join(dir, "wrangler.jsonc"), WRANGLER_JSONC);
    expect(resolveProjectSlug(undefined, true)).toBe("from-wrangler");
  });

  it("uses the wrangler.toml name when there is no creek.toml", () => {
    writeFileSync(
      join(dir, "wrangler.toml"),
      'name = "toml-worker"\nmain = "src/index.ts"\ncompatibility_date = "2026-01-01"\n',
    );
    expect(resolveProjectSlug(undefined, true)).toBe("toml-worker");
  });

  it("matches the name deploy uses (SDK resolveConfig)", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@scope/my-app", dependencies: { astro: "^5.0.0" } }),
    );
    const found = projectFromDirectory();
    expect(found?.slug).toBe("my-app");
    expect(found?.slug).toBe(found?.config.projectName);
    expect(resolveProjectSlug(undefined, true)).toBe(found!.slug);
  });

  it("an empty directory is no_project with the {ok:false,error,message} shape and breadcrumbs", () => {
    expect(projectFromDirectory()).toBeNull();
    expect(exitCode(() => resolveProjectSlug(undefined, true))).toBe(1);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ ok: false, error: "no_project", message: NO_PROJECT_MESSAGE });
    const commands = (out.breadcrumbs as { command: string }[]).map((b) => b.command);
    expect(commands).toContain("creek projects --json");
    expect(commands).toContain("creek init");
  });

  it("a malformed creek.toml is invalid_config, not a stack trace", () => {
    writeFileSync(join(dir, "creek.toml"), "[project\nname=");
    expect(exitCode(() => resolveProjectSlug(undefined, true))).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: "invalid_config" });
  });
});

describe("the no_project hint names only flags the command accepts", () => {
  // The message suggests --project, so every command that can reach it must
  // take --project. citty rejects an unknown flag, so an agent following the
  // hint would otherwise hit unknown_flag.
  const sub = (cmd: CommandDef, name: string) =>
    (cmd.subCommands as Record<string, CommandDef>)[name];
  const projectCommands: Record<string, CommandDef> = {
    "env set": sub(envCommand, "set"),
    "env ls": sub(envCommand, "ls"),
    "env rm": sub(envCommand, "rm"),
    "env unset": sub(envCommand, "unset"),
    deployments: deploymentsCommand,
    "deployments list": sub(deploymentsCommand, "list"),
    "deployments logs": sub(deploymentsCommand, "logs"),
    "domains ls": sub(domainsCommand, "ls"),
    "domains show": sub(domainsCommand, "show"),
    "domains add": sub(domainsCommand, "add"),
    "domains rm": sub(domainsCommand, "rm"),
    "domains activate": sub(domainsCommand, "activate"),
    "queue send": sub(queueCommand, "send"),
    logs: logsCommand,
    metrics: metricsCommand,
    rollback: rollbackCommand,
    status: statusCommand,
    "db shell": sub(dbCommand, "shell"),
    "db migrate": sub(dbCommand, "migrate"),
    doctor: doctorCommand,
  };

  for (const [name, cmd] of Object.entries(projectCommands)) {
    it(`creek ${name} accepts --project`, () => {
      expect(cmd, name).toBeDefined();
      const args = cmd.args as ArgsDef;
      expect(args.project, name).toMatchObject({ type: "string" });
    });
  }

  it("the message suggests no flag but --project", () => {
    const flags = NO_PROJECT_MESSAGE.match(/--[a-z][a-z-]*/g) ?? [];
    expect(flags).toEqual(["--project"]);
  });

  it("every command module that resolves a project is covered above", () => {
    // A new caller of resolveProjectSlug must be added to projectCommands,
    // so its arg schema is checked for --project too.
    const commandsDir = join(__dirname, "..", "commands");
    const covered = new Set([
      "env.ts",
      "deployments.ts",
      "domains.ts",
      "queue.ts",
      "logs.ts",
      "metrics.ts",
      "rollback.ts",
      "status.ts",
      "db.ts",
      "doctor.ts",
    ]);
    const callers = readdirSync(commandsDir).filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.includes(".test") &&
        /resolveProjectSlug\(|projectFromDirectory\(|NO_PROJECT_MESSAGE/.test(
          readFileSync(join(commandsDir, f), "utf-8"),
        ),
    );
    expect(callers.filter((f) => !covered.has(f))).toEqual([]);
  });
});
