import { describe, expect, it } from "vitest";
import { defineCommand } from "citty";
import { buildHelpSchema, helpPath, walkCommand } from "./help-schema.js";
import { deployCommand } from "./commands/deploy.js";
import { envCommand } from "./commands/env.js";

describe("helpPath", () => {
  it("strips flags and keeps the command path", () => {
    expect(helpPath(["--help", "--json"])).toEqual([]);
    expect(helpPath(["deploy", "--help", "--json"])).toEqual(["deploy"]);
    expect(helpPath(["env", "set", "-h"])).toEqual(["env", "set"]);
  });
});

describe("walkCommand", () => {
  it("marks commands with --dry-run as destructive", () => {
    const child = defineCommand({
      meta: { name: "zap", description: "explode" },
      args: { "dry-run": { type: "boolean", default: false, description: "preview" } },
    });
    const walked = walkCommand(child, "zap");
    expect(walked).toMatchObject({ name: "zap", dryRun: true, destructive: true });
    expect(walked.args.some((a) => a.name === "dry-run")).toBe(true);
  });

  it("does not mark read-only commands as destructive", () => {
    const child = defineCommand({
      meta: { name: "ls" },
      args: { json: { type: "boolean", default: false } },
    });
    expect(walkCommand(child, "ls")).toMatchObject({ dryRun: false, destructive: false });
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
    },
  });

  it("dumps the root tree and strips the glyph from the name", () => {
    const schema = buildHelpSchema(app, ["--help", "--json"]);
    expect(schema).toMatchObject({ ok: true, path: [] });
    if (!schema.ok) throw new Error("expected ok");
    expect(schema.command.name).toBe("creek");
    expect(schema.command.version).toBe("0.0.0");
    expect(schema.command.subcommands.map((c) => c.name)).toEqual(["child"]);
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

  it("returns unknown_command for a bogus path", () => {
    expect(buildHelpSchema(app, ["nope", "--help", "--json"])).toMatchObject({
      ok: false,
      error: "unknown_command",
    });
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
});
