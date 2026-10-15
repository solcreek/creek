import { describe, expect, it } from "vitest";
import { defineCommand } from "citty";
import {
  buildHelpSchema,
  findUnknownFlags,
  unknownFlagMessage,
  walkCommand,
} from "./help-schema.js";
import { deployCommand } from "./commands/deploy.js";
import { envCommand } from "./commands/env.js";
import { rollbackCommand } from "./commands/rollback.js";
import { statusCommand } from "./commands/status.js";
import { createMain } from "./command-tree.js";
import type { HelpCommand } from "./help-schema.js";

describe("walkCommand", () => {
  it("takes destructive from the definition, not from --dry-run", () => {
    const run = () => {};
    const zap = defineCommand({
      meta: { name: "zap", description: "explode", destructive: true },
      args: { json: { type: "boolean", default: false } },
      run,
    });
    expect(walkCommand(zap, "zap")).toMatchObject({ dryRun: false, destructive: true });

    const plan = defineCommand({
      meta: { name: "plan", destructive: false },
      args: { "dry-run": { type: "boolean", default: false, description: "preview" } },
      run,
    });
    const walked = walkCommand(plan, "plan");
    expect(walked).toMatchObject({ dryRun: true, destructive: false });
    expect(walked.args.some((a) => a.name === "dry-run")).toBe(true);
  });

  it("reads an unmarked runnable command as destructive, a group as not", () => {
    const unmarked = defineCommand({ meta: { name: "new" }, run: () => {} });
    expect(walkCommand(unmarked, "new").destructive).toBe(true);
    const group = defineCommand({ meta: { name: "grp" }, subCommands: { new: unmarked } });
    expect(walkCommand(group, "grp").destructive).toBe(false);
  });

  it("lists a command registered under two names once, with the other as an alias", () => {
    const rm = defineCommand({ meta: { name: "rm", destructive: true }, run: () => {} });
    const group = defineCommand({ meta: { name: "grp" }, subCommands: { unset: rm, rm } });
    const walked = walkCommand(group, "grp");
    expect(walked.subcommands.map((c) => [c.name, c.aliases])).toEqual([["rm", ["unset"]]]);
  });

  it("includes an arg's allowed values", () => {
    const cmd = defineCommand({
      meta: { name: "pick", destructive: false },
      args: { color: { type: "string", enum: ["red", "blue"] } },
      run: () => {},
    });
    expect(walkCommand(cmd, "pick").args[0]).toMatchObject({
      name: "color",
      enum: ["red", "blue"],
    });
  });
});

describe("buildHelpSchema", () => {
  const app = defineCommand({
    meta: { name: "⬡ creek", version: "0.0.0", description: "edge" },
    subCommands: {
      child: defineCommand({
        meta: { name: "child", description: "a child" },
        args: { name: { type: "positional", required: true, description: "who" } },
      }),
      env: envCommand,
      deploy: deployCommand,
    },
  });

  it("dumps the root tree and strips the glyph from the name", () => {
    const schema = buildHelpSchema(app, ["--help", "--json"]);
    expect(schema).toMatchObject({ ok: true, path: [] });
    if (!schema.ok) throw new Error("expected ok");
    expect(schema.command.name).toBe("creek");
    expect(schema.command.version).toBe("0.0.0");
    expect(schema.command.subcommands.map((c) => c.name)).toEqual(["child", "env", "deploy"]);
  });

  it("resolves a nested path", () => {
    const schema = buildHelpSchema(app, ["child", "--help"]);
    expect(schema).toMatchObject({ ok: true, path: ["child"] });
    if (!schema.ok) throw new Error("expected ok");
    expect(schema.command.name).toBe("child");
    expect(schema.command.args[0]).toMatchObject({
      name: "name",
      type: "positional",
      required: true,
    });
  });

  it("stops at positionals of a nested command", () => {
    const schema = buildHelpSchema(app, ["env", "set", "KEY", "VALUE", "--help", "--json"]);
    expect(schema).toMatchObject({ ok: true, path: ["env", "set"] });
    if (!schema.ok) throw new Error("expected ok");
    expect(schema.command.name).toBe("set");
  });

  it("returns unknown_command for a bad child of a parent with subcommands", () => {
    expect(buildHelpSchema(app, ["env", "nope", "--help", "--json"])).toMatchObject({
      ok: false,
      error: "unknown_command",
    });
  });

  it("returns unknown_command for leftover tokens when the command has no positional", () => {
    expect(buildHelpSchema(app, ["env", "ls", "extra", "--help", "--json"])).toMatchObject({
      ok: false,
      error: "unknown_command",
    });
  });

  it("treats a leftover as a positional when the command declares one", () => {
    const schema = buildHelpSchema(app, ["deploy", "./dist", "--help", "--json"]);
    expect(schema).toMatchObject({ ok: true, path: ["deploy"] });
    if (!schema.ok) throw new Error("expected ok");
    expect(schema.command.name).toBe("deploy");
  });

  it("skips option values that are not subcommands", () => {
    const schema = buildHelpSchema(app, ["deploy", "--project", "app", "--help", "--json"]);
    expect(schema).toMatchObject({ ok: true, path: ["deploy"] });
    if (!schema.ok) throw new Error("expected ok");
    expect(schema.command.name).toBe("deploy");
  });

  it("does not treat a boolean global flag's neighbor as an option value", () => {
    const schema = buildHelpSchema(app, ["--json", "env", "set", "--help"]);
    expect(schema).toMatchObject({ ok: true, path: ["env", "set"] });
  });

  it("returns unknown_command for a bogus path", () => {
    expect(buildHelpSchema(app, ["nope", "--help"])).toMatchObject({
      ok: false,
      error: "unknown_command",
    });
  });
});

describe("findUnknownFlags", () => {
  const mini = defineCommand({
    meta: { name: "creek" },
    subCommands: {
      status: defineCommand({
        meta: { name: "status" },
        args: { json: { type: "boolean" } },
      }),
      rollback: defineCommand({
        meta: { name: "rollback" },
        args: {
          "dry-run": { type: "boolean", default: false },
          json: { type: "boolean" },
        },
      }),
    },
  });

  it("allows --dry-run on a command that declares it", () => {
    expect(findUnknownFlags(mini, ["rollback", "--dry-run", "--json"])).toEqual([]);
  });

  it("rejects --dry-run on a command that does not declare it", () => {
    expect(findUnknownFlags(mini, ["status", "--dry-run", "--json"])).toEqual(["--dry-run"]);
  });

  it("rejects --project when the command has no such flag", () => {
    expect(findUnknownFlags(mini, ["status", "--project", "www"])).toEqual(["--project"]);
  });

  it("does not flag unknown commands (those are unknown_command)", () => {
    expect(findUnknownFlags(mini, ["bogus", "--dry-run"])).toEqual([]);
  });

  it("names --dry-run as a silent-drop hazard", () => {
    expect(unknownFlagMessage(["--dry-run"], ["status"])).toContain("silently dropped");
  });

  it("rejects -y when the command did not declare yes", () => {
    expect(findUnknownFlags(mini, ["status", "-y"])).toEqual(["-y"]);
  });

  it("rejects --yes when the command did not spread globalArgs", () => {
    expect(findUnknownFlags(mini, ["status", "--yes"])).toEqual(["--yes"]);
  });
});

describe("real command tree", () => {
  it("deploy exposes --sandbox/--prod/--dry-run", () => {
    const walked = walkCommand(deployCommand, "deploy");
    const names = walked.args.map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(["sandbox", "prod", "dry-run", "json"]));
    expect(walked.dryRun).toBe(true);
    expect(walked.destructive).toBe(true);
  });

  it("env set is a destructive subcommand with --dry-run", () => {
    const walked = walkCommand(envCommand, "env");
    const set = walked.subcommands.find((c) => c.name === "set");
    expect(set).toMatchObject({ dryRun: true, destructive: true });
  });

  it("env lists rm once, with unset as its alias", () => {
    const walked = walkCommand(envCommand, "env");
    expect(walked.subcommands.map((c) => c.name)).toEqual(["set", "ls", "rm"]);
    expect(walked.subcommands.find((c) => c.name === "rm")?.aliases).toEqual(["unset"]);
  });

  it("env unset --help resolves to rm", () => {
    const schema = buildHelpSchema(createMain("0.0.0"), ["env", "unset", "--help", "--json"]);
    expect(schema).toMatchObject({ ok: true, path: ["env", "unset"], command: { name: "rm" } });
  });

  it("env --target lists its allowed values", () => {
    const walked = walkCommand(envCommand, "env");
    for (const name of ["set", "rm"]) {
      const target = walked.subcommands
        .find((c) => c.name === name)
        ?.args.find((a) => a.name === "target");
      expect(target?.enum, name).toEqual(["all", "production", "preview"]);
    }
  });

  it("rollback declares --dry-run; status does not", () => {
    expect(findUnknownFlags(rollbackCommand, ["--dry-run", "--json"])).toEqual([]);
    expect(findUnknownFlags(statusCommand, ["--dry-run", "--json"])).toEqual(["--dry-run"]);
  });

  it("accepts -y / --yes only when globalArgs.yes is declared", () => {
    const yes = walkCommand(rollbackCommand, "rollback").args.find((a) => a.name === "yes");
    expect(yes?.alias).toBe("y");
    expect(findUnknownFlags(rollbackCommand, ["-y", "--json"])).toEqual([]);
    expect(findUnknownFlags(rollbackCommand, ["--yes", "--json"])).toEqual([]);
    expect(findUnknownFlags(statusCommand, ["-y", "--json"])).toEqual([]);
    expect(findUnknownFlags(statusCommand, ["--yes", "--json"])).toEqual([]);
  });
});

/**
 * Every runnable command, reviewed: `true` if running it may delete or
 * overwrite existing data, or change what is live. Add a new command here
 * after deciding; the test fails until you do, so nothing ships unmarked.
 */
const REVIEWED_DESTRUCTIVE: Record<string, boolean> = {
  dev: false, // --reset clears only local dev data
  deploy: true, // --prod replaces what production serves
  status: false,
  projects: false, // runs `projects list`
  "projects list": false,
  "projects delete": true,
  deployments: false, // runs `deployments list`
  "deployments list": false,
  "deployments logs": false,
  "deployments get": false,
  "deployments wait": false, // polls only
  logs: false,
  metrics: false,
  doctor: false,
  verify: false,
  login: false, // replaces only the locally stored key
  whoami: false,
  init: true, // overwrites an existing creek.toml (no prompt with --yes)
  claim: false,
  "env set": true, // overwrites the key's value for the target
  "env ls": false,
  "env rm": true,
  "queue send": false,
  "db ls": false,
  "db create": false,
  "db attach": false,
  "db detach": true,
  "db rename": false,
  "db delete": true,
  "db shell": true, // runs arbitrary SQL
  "db migrate": true,
  "db seed": true, // runs the seed file's SQL
  "storage ls": false,
  "storage create": false,
  "storage attach": false,
  "storage detach": true,
  "storage rename": false,
  "storage delete": true,
  "cache ls": false,
  "cache create": false,
  "cache attach": false,
  "cache detach": true,
  "cache rename": false,
  "cache delete": true,
  "domains ls": false,
  "domains show": false,
  "domains add": false,
  "domains rm": true,
  "domains activate": false,
  rollback: true,
  top: false,
  dashboard: false,
  restart: true, // interrupts the running app
  stop: true,
  ops: false,
};

type Def = {
  meta?: { name?: string; destructive?: unknown };
  subCommands?: Record<string, Def>;
  run?: unknown;
};

/** Every runnable command in the tree, by its path of keys (aliases skipped). */
function runnable(cmd: Def, path: string[] = []): { path: string; def: Def }[] {
  const out =
    typeof cmd.run === "function" && path.length > 0 ? [{ path: path.join(" "), def: cmd }] : [];
  const seen = new Set<Def>();
  for (const [key, child] of Object.entries(cmd.subCommands ?? {})) {
    if (seen.has(child)) continue;
    seen.add(child);
    const name = child.meta?.name === key ? key : (child.meta?.name ?? key);
    out.push(...runnable(child, [...path, name]));
  }
  return out;
}

function schemaNodes(node: HelpCommand, path: string[] = []): Map<string, HelpCommand> {
  const out = new Map<string, HelpCommand>();
  if (path.length > 0) out.set(path.join(" "), node);
  for (const child of node.subcommands) {
    for (const [k, v] of schemaNodes(child, [...path, child.name])) out.set(k, v);
  }
  return out;
}

describe("destructive flags of the real command tree", () => {
  const main = createMain("0.0.0") as unknown as Def;
  const commands = runnable(main);

  it("every runnable command sets meta.destructive in its definition", () => {
    const unmarked = commands
      .filter(({ def }) => typeof def.meta?.destructive !== "boolean")
      .map(({ path }) => path);
    expect(unmarked).toEqual([]);
  });

  it("every runnable command is in the reviewed list, and nothing else is", () => {
    expect(commands.map(({ path }) => path).sort()).toEqual(
      Object.keys(REVIEWED_DESTRUCTIVE).sort(),
    );
  });

  it("--help --json reports each command's reviewed destructive flag", () => {
    const schema = buildHelpSchema(main, ["--help", "--json"]);
    if (!schema.ok) throw new Error("expected ok");
    const nodes = schemaNodes(schema.command);
    const reported = Object.fromEntries(
      Object.keys(REVIEWED_DESTRUCTIVE).map((path) => [path, nodes.get(path)?.destructive]),
    );
    expect(reported).toEqual(REVIEWED_DESTRUCTIVE);
  });
});
