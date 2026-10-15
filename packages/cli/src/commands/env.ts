import { defineCommand } from "citty";
import consola from "consola";
import { globalArgs, resolveJsonMode, jsonOutput, type Breadcrumb } from "../utils/output.js";
import {
  requireClient,
  resolveProject,
  apiCall,
  projectArg,
  projectBreadcrumbs,
} from "../utils/command-context.js";
import { dryRunArg, emitDryRunPlan, isDryRun } from "../utils/dry-run.js";
import { CreekApiError, type CreekClient, type EnvTarget } from "@solcreek/sdk";

const TARGETS: readonly EnvTarget[] = ["all", "production", "preview"];

const targetArg = {
  target: {
    type: "string" as const,
    description:
      "Which deploys get this value: production, preview (branch deploys) or all. Default: all",
  },
};

/**
 * ` --project <slug>` when the user named the project, so the commands we hand
 * back (breadcrumbs, dry-run next steps) target it from any directory.
 */
function projectFlag(project: unknown): string {
  return typeof project === "string" && project ? ` --project ${project}` : "";
}

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

/** What a server without targets did with a per-target `set`, and the way back. */
function targetUnsupportedMessage(key: string, target: EnvTarget): string {
  const base = `The server does not support --target and stored ${key} for all deploys.`;
  return target === "preview"
    ? `${base} Production deploys now get this preview value, replacing any value production had: set the production value again with \`creek env set ${key} '<VALUE>'\`.`
    : `${base} Previews get it too: remove it with \`creek env rm ${key}\` if they must not.`;
}

/** The deploys that pick up a change to this target. */
function appliesOn(target: EnvTarget): string {
  if (target === "production") return "the next production deploy";
  if (target === "preview") return "the next branch (preview) deploy";
  return "the next deploy";
}

const ALREADY_ABSENT = Symbol("already-absent");

/** The API's key rule (control-plane env routes, POST). */
const ENV_KEY_SHAPE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Whether a failed delete means the key (or its target's value) isn't set on
 * an existing project, not that the project is missing or the call failed.
 * The API says so with `missing: "envvar"` on its 404. An older API sends a
 * bare 404 for both: then the project's list decides — it must load (so the
 * project exists) and not hold the value.
 */
async function isAlreadyAbsent(
  client: CreekClient,
  slug: string,
  key: string,
  target: EnvTarget | undefined,
  err: unknown,
): Promise<boolean> {
  if (!(err instanceof CreekApiError) || err.status !== 404) return false;
  if (err.details.missing === "envvar") return true;
  if (err.details.missing !== undefined) return false;
  const vars = await client.listEnvVars(slug).catch(() => null);
  if (!vars) return false;
  return !vars.some((v) => v.key === key && (!target || (v.target ?? "all") === target));
}

const envSet = defineCommand({
  meta: { name: "set", description: "Set an environment variable" },
  args: {
    key: { type: "positional", description: "Variable name (e.g. DATABASE_URL)", required: true },
    value: { type: "positional", description: "Variable value", required: true },
    ...targetArg,
    ...dryRunArg,
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const target = parseTarget(jsonMode, args.target, "all")!;
    const client = requireClient(jsonMode);
    const { slug, source: projectSource } = resolveProject(args.project, jsonMode);
    const targetFlag = target === "all" ? "" : ` --target ${target}`;
    const pf = projectFlag(args.project);
    if (isDryRun(args)) {
      emitDryRunPlan(jsonMode, {
        command: `creek env set ${args.key} '$VALUE'${targetFlag}${pf}`,
        wouldExecute: true,
        project: slug,
        projectSource,
        key: args.key,
        target,
        pendingDeploy: true,
        sideEffects: [
          `Store ${args.key} (${target}) on project ${slug} (value not logged)`,
          `Running deployments are unchanged until ${appliesOn(target)}`,
          "Replace $VALUE with the real secret; keep the single quotes",
        ],
        nextStep: `creek env set ${args.key} '$VALUE'${targetFlag}${pf} --json`,
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
      const message = targetUnsupportedMessage(args.key, target);
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
        {
          ok: true,
          key: args.key,
          target,
          project: slug,
          projectSource,
          applied: false,
          pendingDeploy: true,
        },
        0,
        projectBreadcrumbs(slug, [
          { command: `creek env ls${pf} --json`, description: "List all environment variables" },
          { command: "creek deploy --prod --json", description: "Deploy to apply env changes" },
        ]),
      );
    consola.success(`Set ${args.key}${target === "all" ? "" : ` for ${target} deploys`}`);
    // Env vars are injected at deploy time, so a change to a live project does
    // nothing until the next deploy. Say so, or it silently 500s on the old value.
    consola.info(`Takes effect on ${appliesOn(target)}.`);
  },
});

/**
 * Values are write-only: the API stores them encrypted and returns only
 * each key and target. (Its list also sends a `value` that is a masked
 * copy of the key *name*, not of the value; printing it read as a redacted
 * secret, so it is not shown.) `--show` used to print that placeholder as
 * if it were the plaintext; it now refuses, so nobody acts on a value they
 * don't have.
 */
const VALUES_WRITE_ONLY =
  "Environment variable values are write-only: Creek stores them encrypted and never returns them. `creek env ls` lists keys and targets; to change a value, set it again with `creek env set`.";

const envGet = defineCommand({
  meta: {
    name: "ls",
    description: "List environment variable keys and targets (values are write-only)",
  },
  args: {
    show: {
      type: "boolean",
      description:
        "Not supported: values are write-only and are never returned. Exits 1 with values_write_only",
      default: false,
    },
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const pf = projectFlag(args.project);
    if (args.show) {
      if (jsonMode)
        jsonOutput({ ok: false, error: "values_write_only", message: VALUES_WRITE_ONLY }, 1, [
          { command: `creek env ls${pf} --json`, description: "List keys and targets" },
        ]);
      consola.error(VALUES_WRITE_ONLY);
      process.exit(1);
    }
    const client = requireClient(jsonMode);
    const { slug, source: projectSource } = resolveProject(args.project, jsonMode);
    const vars = await apiCall(jsonMode, "api_error", () => client.listEnvVars(slug));

    if (jsonMode) {
      const crumbs: Breadcrumb[] = [
        { command: `creek env set <KEY> <VALUE>${pf}`, description: "Set an environment variable" },
      ];
      if (vars.length > 0) {
        crumbs.push({
          command: `creek env rm ${vars[0].key}${pf}`,
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
          projectSource,
          valuesWriteOnly: true,
          vars: vars.map((v) => ({ key: v.key, target: v.target ?? "all" })),
        },
        0,
        projectBreadcrumbs(slug, crumbs),
      );
    }

    if (vars.length === 0) {
      consola.info("No environment variables set.");
      return;
    }

    for (const v of vars) {
      consola.log(`  ${v.key}  (${v.target ?? "all"})`);
    }
    consola.info("  Values are write-only and are never shown.");
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
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const target = parseTarget(jsonMode, args.target);
    // The API has only ever stored keys of this shape (env set enforces it),
    // so any other key — padded, lowercase — was never set. Say so before any
    // request: on the server it would 404 and read as alreadyAbsent while the
    // key the user meant stays set.
    if (!ENV_KEY_SHAPE.test(args.key)) {
      const message = `"${args.key}" is not a valid key (uppercase letters, digits and underscores, e.g. DATABASE_URL), so it was never set. Nothing was removed.`;
      if (jsonMode) jsonOutput({ ok: false, error: "invalid_key", key: args.key, message }, 1);
      consola.error(message);
      process.exit(1);
    }
    const client = requireClient(jsonMode);
    const { slug, source: projectSource } = resolveProject(args.project, jsonMode);
    const targetFlag = target ? ` --target ${target}` : "";
    const pf = projectFlag(args.project);
    if (isDryRun(args)) {
      const vars = await apiCall(jsonMode, "api_error", () => client.listEnvVars(slug));
      const matching = vars
        .filter((v) => v.key === args.key && (!target || (v.target ?? "all") === target))
        .map((v) => v.target ?? "all");
      const exists = matching.length > 0;
      emitDryRunPlan(jsonMode, {
        command: `creek env rm ${args.key}${targetFlag}${pf}`,
        wouldExecute: exists,
        project: slug,
        projectSource,
        key: args.key,
        targets: matching,
        exists,
        // The run reports the same: nothing to remove succeeds as alreadyAbsent.
        alreadyAbsent: !exists,
        pendingDeploy: exists,
        sideEffects: exists
          ? [
              `Remove ${args.key} (${matching.join(", ")}) from project ${slug}`,
              "Running deployments keep the old value until they are redeployed",
            ]
          : [
              `${args.key}${target ? ` (${target})` : ""} is not set on ${slug} — nothing to remove`,
            ],
        nextStep: exists
          ? `creek env rm ${args.key}${targetFlag}${pf} --json`
          : `creek env ls${pf} --json`,
      });
      return;
    }
    // A server without targets ignores ?target= and deletes the key's only
    // (all-deploys) value. Its list has no target field: refuse instead. The
    // list needs env:read, which a key allowed to delete may lack: on that
    // refusal (403) only, go ahead — a server with targets answers a
    // per-target delete itself (409 env_targets_unavailable before its
    // migration). Any other failure stops here, before a DELETE an old
    // server would apply to the all-deploys value.
    if (target && target !== "all") {
      const vars = await apiCall(jsonMode, "api_error", () =>
        client.listEnvVars(slug).catch((err: unknown) => {
          if ((err as { status?: unknown }).status === 403) return null;
          throw err;
        }),
      );
      if (vars && vars.length > 0 && vars.every((v) => v.target === undefined)) {
        const message = `The server does not support --target, so it would remove the value ${args.key} has for all deploys. Nothing was removed.`;
        if (jsonMode)
          jsonOutput({ ok: false, error: "target_unsupported", message, key: args.key }, 1);
        consola.error(message);
        process.exit(1);
      }
    }
    const result = await apiCall(jsonMode, "rm_failed", () =>
      client
        .deleteEnvVar(slug, args.key, target)
        .catch(async (err: unknown): Promise<typeof ALREADY_ABSENT> => {
          if (await isAlreadyAbsent(client, slug, args.key, target, err)) return ALREADY_ABSENT;
          throw err;
        }),
    );
    const breadcrumbs = projectBreadcrumbs(slug, [
      { command: `creek env ls${pf} --json`, description: "List remaining variables" },
      { command: "creek deploy --prod --json", description: "Deploy to apply env changes" },
    ]);
    // Not set (for this target): nothing to remove, which is the state a
    // re-run asked for. Variables are deleted outright, so one removed by an
    // earlier run and one never set (a typo) can't be told apart: say so
    // rather than claim either. A deploy is still suggested: if an earlier
    // run removed it, running deployments keep the old value until then.
    if (result === ALREADY_ABSENT) {
      const what = `${args.key}${target ? ` (${target})` : ""}`;
      const message = `${what} is not set on ${slug}; nothing was removed. If you expected it, check the name with \`creek env ls${pf}\`.`;
      if (jsonMode)
        jsonOutput(
          {
            ok: true,
            key: args.key,
            ...(target ? { target } : {}),
            alreadyAbsent: true,
            removed: false,
            removedValues: 0,
            project: slug,
            projectSource,
            applied: false,
            pendingDeploy: true,
            message,
          },
          0,
          breadcrumbs,
        );
      consola.success(message);
      return;
    }
    // Same deploy-time injection as `set`: the var is removed from the
    // store but the running worker keeps the old value until redeploy.
    if (jsonMode)
      jsonOutput(
        {
          ok: true,
          key: args.key,
          ...(target ? { target } : {}),
          alreadyAbsent: false,
          removed: true,
          removedValues: result.removed ?? 1,
          project: slug,
          projectSource,
          applied: false,
          pendingDeploy: true,
        },
        0,
        breadcrumbs,
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
