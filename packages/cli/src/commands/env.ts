import { defineCommand } from "citty";
import consola from "consola";
import { globalArgs, resolveJsonMode, jsonOutput, type Breadcrumb } from "../utils/output.js";
import { requireClient, resolveProjectSlug, apiCall } from "../utils/command-context.js";

const envSet = defineCommand({
  meta: { name: "set", description: "Set an environment variable" },
  args: {
    key: { type: "positional", description: "Variable name (e.g. DATABASE_URL)", required: true },
    value: { type: "positional", description: "Variable value", required: true },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = requireClient(jsonMode);
    const slug = resolveProjectSlug(undefined, jsonMode);
    await apiCall(jsonMode, "set_failed", () => client.setEnvVar(slug, args.key, args.value));
    // Env vars are injected at deploy time — the change is stored but NOT
    // live on the running worker until the next deploy. Signal that
    // structurally so an agent doesn't assume it took effect immediately.
    if (jsonMode)
      jsonOutput(
        { ok: true, key: args.key, project: slug, applied: false, pendingDeploy: true },
        0,
        [
          {
            command: `creek env ls --project ${slug}`,
            description: "List all environment variables",
          },
          { command: `creek deploy`, description: "Deploy to apply changes" },
        ],
      );
    consola.success(`Set ${args.key}`);
    // Env vars are injected at deploy time, so a change to a live project does
    // nothing until the next deploy. Say so, or it silently 500s on the old value.
    consola.info("Run `creek deploy` to apply this to your live deployment.");
  },
});

function redact(value: string): string {
  if (value.length <= 4) return "••••";
  return value.slice(0, 2) + "•".repeat(Math.min(value.length - 4, 20)) + value.slice(-2);
}

const envGet = defineCommand({
  meta: { name: "ls", description: "List environment variables" },
  args: {
    show: {
      type: "boolean",
      description: "Show values in plaintext (default: redacted)",
      default: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = requireClient(jsonMode);
    const slug = resolveProjectSlug(undefined, jsonMode);
    const vars = await apiCall(jsonMode, "api_error", () => client.listEnvVars(slug));

    if (jsonMode) {
      const crumbs: Breadcrumb[] = [
        { command: `creek env set <KEY> <VALUE>`, description: "Set an environment variable" },
      ];
      if (vars.length > 0) {
        crumbs.push({
          command: `creek env rm ${vars[0].key}`,
          description: `Remove ${vars[0].key}`,
        });
      }
      crumbs.push({ command: "creek deploy", description: "Deploy to apply changes" });
      jsonOutput(
        {
          ok: true,
          project: slug,
          vars: vars.map((v) => ({ key: v.key, value: args.show ? v.value : redact(v.value) })),
        },
        0,
        crumbs,
      );
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
    const client = requireClient(jsonMode);
    const slug = resolveProjectSlug(undefined, jsonMode);
    await apiCall(jsonMode, "rm_failed", () => client.deleteEnvVar(slug, args.key));
    // Same deploy-time injection as `set`: the var is removed from the
    // store but the running worker keeps the old value until redeploy.
    if (jsonMode)
      jsonOutput(
        {
          ok: true,
          key: args.key,
          removed: true,
          project: slug,
          applied: false,
          pendingDeploy: true,
        },
        0,
        [
          { command: `creek env ls --project ${slug}`, description: "List remaining variables" },
          { command: "creek deploy", description: "Deploy to apply changes" },
        ],
      );
    consola.success(`Removed ${args.key}`);
    consola.info("Run `creek deploy` to apply this to your live deployment.");
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
    // `unset` is a common muscle-memory verb (shell, Vercel, Fly). Without
    // this alias, `creek env unset KEY` hit citty's "unknown command" path,
    // printed usage, and left the var in place — reading as if it worked.
    unset: envRm,
  },
});
