import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient, parseConfig } from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalArgs, resolveJsonMode, jsonOutput, type Breadcrumb } from "../utils/output.js";

function getProjectSlug(): string {
  const configPath = join(process.cwd(), "creek.toml");
  if (!existsSync(configPath)) {
    consola.error("No creek.toml found. Run `creek init` first.");
    process.exit(1);
  }
  return parseConfig(readFileSync(configPath, "utf-8")).project.name;
}

function getClient(): CreekClient {
  const token = getToken();
  if (!token) {
    consola.error("Not authenticated. Run `creek login` first.");
    process.exit(1);
  }
  return new CreekClient(getApiUrl(), token);
}

const envSet = defineCommand({
  meta: { name: "set", description: "Set an environment variable" },
  args: {
    key: { type: "positional", description: "Variable name (e.g. DATABASE_URL)", required: true },
    value: { type: "positional", description: "Variable value", required: true },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = getClient();
    const slug = getProjectSlug();
    await client.setEnvVar(slug, args.key, args.value);
    if (jsonMode) jsonOutput({ ok: true, key: args.key, project: slug }, 0, [
      { command: `creek env ls --project ${slug}`, description: "List all environment variables" },
      { command: `creek deploy`, description: "Deploy to apply changes" },
    ]);
    consola.success(`Set ${args.key}`);
  },
});

function redact(value: string): string {
  if (value.length <= 4) return "••••";
  return value.slice(0, 2) + "•".repeat(Math.min(value.length - 4, 20)) + value.slice(-2);
}

const envGet = defineCommand({
  meta: { name: "ls", description: "List environment variables" },
  args: {
    show: { type: "boolean", description: "Show values in plaintext (default: redacted)", default: false },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = getClient();
    const slug = getProjectSlug();
    const vars = await client.listEnvVars(slug);

    if (jsonMode) {
      const crumbs: Breadcrumb[] = [
        { command: `creek env set <KEY> <VALUE>`, description: "Set an environment variable" },
      ];
      if (vars.length > 0) {
        crumbs.push({ command: `creek env rm ${vars[0].key}`, description: `Remove ${vars[0].key}` });
      }
      crumbs.push({ command: "creek deploy", description: "Deploy to apply changes" });
      jsonOutput({
        ok: true,
        project: slug,
        vars: vars.map((v) => ({ key: v.key, value: args.show ? v.value : redact(v.value) })),
      }, 0, crumbs);
    }

    if (vars.length === 0) {
      consola.info("No environment variables set.");
      return;
    }

    for (const v of vars) {
      const displayed = args.show ? v.value : redact(v.value);
      consola.log(`  ${v.key} = ${displayed}`);
    }

    if (!args.show) {
      consola.info("  (use --show to reveal values)");
    }
  },
});

const envRm = defineCommand({
  meta: { name: "rm", description: "Remove an environment variable" },
  args: {
    key: { type: "positional", description: "Variable name to remove", required: true },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = getClient();
    const slug = getProjectSlug();
    await client.deleteEnvVar(slug, args.key);
    if (jsonMode) jsonOutput({ ok: true, key: args.key, removed: true, project: slug }, 0, [
      { command: `creek env ls --project ${slug}`, description: "List remaining variables" },
      { command: "creek deploy", description: "Deploy to apply changes" },
    ]);
    consola.success(`Removed ${args.key}`);
  },
});

export const envCommand = defineCommand({
  meta: {
    name: "env",
    description: "Manage environment variables",
  },
  subCommands: {
    set: envSet,
    ls: envGet,
    rm: envRm,
  },
});
