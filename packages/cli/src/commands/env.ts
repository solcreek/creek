import { defineCommand } from "citty";
import consola from "consola";
import { globalArgs, resolveJsonMode, jsonOutput, type Breadcrumb } from "../utils/output.js";
import { requireClient, resolveProjectSlug, apiCall } from "../utils/command-context.js";
import { dryRunArg, emitDryRunPlan, isDryRun } from "../utils/dry-run.js";
import type { EnvTarget } from "@solcreek/sdk";

const TARGETS: readonly EnvTarget[] = ["all", "production", "preview"];

const targetArg = {
  target: {
    type: "string" as const,
    description:
      "Which deploys get this value: production, preview (branch deploys) or all. Default: all",
  },
};

/** Parse --target, or exit with invalid_target. */
function parseTarget(
  jsonMode: boolean,
  value: unknown,
  fallback?: EnvTarget,
): EnvTarget | undefined {
  if (value === undefined || value === "") return fallback;
  if (typeof value === "string" && (TARGETS as readonly string[]).includes(value)) {
    return value as EnvTarget;
  }
  const message = `--target must be one of: ${TARGETS.join(", ")}`;
  if (jsonMode) jsonOutput({ ok: false, error: "invalid_target", message }, 1);
  consola.error(message);
  process.exit(1);
}

/** The deploys that pick up a change to this target. */
function appliesOn(target: EnvTarget): string {
  if (target === "production") return "the next production deploy";
  if (target === "preview") return "the next branch (preview) deploy";
  return "the next deploy";
}

const envSet = defineCommand({
  meta: { name: "set", description: "Set an environment variable" },
  args: {
    key: { type: "positional", description: "Variable name (e.g. DATABASE_URL)", required: true },
    value: { type: "positional", description: "Variable value", required: true },
    ...targetArg,
    ...dryRunArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const target = parseTarget(jsonMode, args.target, "all")!;
    const client = requireClient(jsonMode);
    const slug = resolveProjectSlug(undefined, jsonMode);
    const targetFlag = target === "all" ? "" : ` --target ${target}`;
    if (isDryRun(args)) {
      emitDryRunPlan(jsonMode, {
        command: `creek env set ${args.key} '$VALUE'${targetFlag}`,
        wouldExecute: true,
        project: slug,
        key: args.key,
        target,
        pendingDeploy: true,
        sideEffects: [
          `Store ${args.key} (${target}) on project ${slug} (value not logged)`,
          `Running deployments are unchanged until ${appliesOn(target)}`,
          "Replace $VALUE with the real secret; keep the single quotes",
        ],
        nextStep: `creek env set ${args.key} '$VALUE'${targetFlag} --json`,
      });
      return;
    }
    const result = await apiCall(jsonMode, "set_failed", () =>
      client.setEnvVar(slug, args.key, args.value, target === "all" ? undefined : target),
    );
    // A server (or SDK) without targets ignores the target and stores the
    // value for every deploy — the opposite of what --target production asks
    // for. Refuse to report success unless the server echoed the target.
    if ((result.target ?? "all") !== target) {
      const message = `The server stored ${args.key} for all deploys, not only ${target}: it does not support --target. Remove it with \`creek env rm ${args.key}\` if previews must not see it.`;
      if (jsonMode)
        jsonOutput({ ok: false, error: "target_unsupported", message, key: args.key }, 1);
      consola.error(message);
      process.exit(1);
    }
    // Env vars are injected at deploy time — the change is stored but NOT
    // live on the running worker until the next deploy. Signal that
    // structurally so an agent doesn't assume it took effect immediately.
    if (jsonMode)
      jsonOutput(
        { ok: true, key: args.key, target, project: slug, applied: false, pendingDeploy: true },
        0,
        [
          { command: "creek env ls --json", description: "List all environment variables" },
          { command: "creek deploy --prod --json", description: "Deploy to apply env changes" },
        ],
      );
    consola.success(`Set ${args.key}${target === "all" ? "" : ` for ${target} deploys`}`);
    // Env vars are injected at deploy time, so a change to a live project does
    // nothing until the next deploy. Say so, or it silently 500s on the old value.
    consola.info(`Takes effect on ${appliesOn(target)}.`);
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
      crumbs.push({
        command: "creek deploy --prod --json",
        description: "Deploy to apply env changes",
      });
      jsonOutput(
        {
          ok: true,
          project: slug,
          vars: vars.map((v) => ({
            key: v.key,
            target: v.target ?? "all",
            value: args.show ? v.value : redact(v.value),
          })),
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
      consola.log(`  ${v.key} = ${displayed}  (${v.target ?? "all"})`);
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
    target: {
      type: "string" as const,
      description:
        "Remove only the value for production, preview or all. Default: every value of the key",
    },
    ...dryRunArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const target = parseTarget(jsonMode, args.target);
    const client = requireClient(jsonMode);
    const slug = resolveProjectSlug(undefined, jsonMode);
    const targetFlag = target ? ` --target ${target}` : "";
    if (isDryRun(args)) {
      const vars = await apiCall(jsonMode, "api_error", () => client.listEnvVars(slug));
      const matching = vars
        .filter((v) => v.key === args.key && (!target || (v.target ?? "all") === target))
        .map((v) => v.target ?? "all");
      const exists = matching.length > 0;
      emitDryRunPlan(jsonMode, {
        command: `creek env rm ${args.key}${targetFlag}`,
        wouldExecute: exists,
        project: slug,
        key: args.key,
        targets: matching,
        exists,
        pendingDeploy: exists,
        sideEffects: exists
          ? [
              `Remove ${args.key} (${matching.join(", ")}) from project ${slug}`,
              "Running deployments keep the old value until they are redeployed",
            ]
          : [
              `${args.key}${target ? ` (${target})` : ""} is not set on ${slug} — nothing to remove`,
            ],
        nextStep: exists ? `creek env rm ${args.key}${targetFlag} --json` : `creek env ls --json`,
      });
      return;
    }
    const result = await apiCall(jsonMode, "rm_failed", () =>
      client.deleteEnvVar(slug, args.key, target),
    );
    // Same deploy-time injection as `set`: the var is removed from the
    // store but the running worker keeps the old value until redeploy.
    if (jsonMode)
      jsonOutput(
        {
          ok: true,
          key: args.key,
          ...(target ? { target } : {}),
          removed: true,
          removedValues: result.removed ?? 1,
          project: slug,
          applied: false,
          pendingDeploy: true,
        },
        0,
        [
          { command: "creek env ls --json", description: "List remaining variables" },
          { command: "creek deploy --prod --json", description: "Deploy to apply env changes" },
        ],
      );
    consola.success(`Removed ${args.key}${target ? ` (${target})` : ""}`);
    consola.info("Running deployments keep the old value until they are redeployed.");
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
