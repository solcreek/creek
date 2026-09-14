import { describe, expect, it } from "vitest";
import { defineCommand } from "citty";
import { buildHelpSchema, walkCommand } from "./help-schema.js";
import { deployCommand } from "./commands/deploy.js";
import { envCommand } from "./commands/env.js";

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
