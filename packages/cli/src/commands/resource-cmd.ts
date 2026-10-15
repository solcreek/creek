/**
 * Factory for resource subcommands (creek db, creek storage, creek cache).
 *
 * All resource kinds share the same CRUD shape:
 *   ls, create, attach, detach, rename, delete
 *
 * Only the `kind` value and display labels differ.
 */

import { defineCommand } from "citty";
import consola from "consola";
import { CreekApiError, CreekClient } from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import {
  globalArgs,
  resolveJsonMode,
  jsonOutput,
  AUTH_BREADCRUMBS,
  shouldAutoConfirm,
  isTTY,
} from "../utils/output.js";
import { apiCall } from "../utils/command-context.js";
import { dryRunArg, emitDryRunPlan, isDryRun } from "../utils/dry-run.js";
import { apiErrorFields, apiErrorHints } from "../utils/api-error.js";

interface Resource {
  id: string;
  teamId: string;
  kind: string;
  name: string;
  cfResourceId: string | null;
  cfResourceType: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

interface ResourceCmdOptions {
  kind: "database" | "storage" | "cache" | "ai";
  /** Singular label for display, e.g. "database", "storage bucket", "cache namespace" */
  label: string;
  /** Default binding name, e.g. "DB", "STORAGE", "KV" */
  defaultBinding: string;
}

function requireToken(jsonMode: boolean): string {
  const token = getToken();
  if (!token) {
    if (jsonMode)
      jsonOutput(
        {
          ok: false,
          error: "not_authenticated",
          message: "Not authenticated. Run `creek login` first.",
        },
        1,
        AUTH_BREADCRUMBS,
      );
    consola.error("Not authenticated. Run `creek login` first.");
    process.exit(1);
  }
  return token;
}

async function findByName(
  client: CreekClient,
  name: string,
  kind: string,
  jsonMode: boolean,
): Promise<Resource | null> {
  // Called before the ops' own try/catch, so wrap the list here — otherwise a
  // rejection escapes to the top-level catch as unstructured text in JSON mode.
  const { resources } = await apiCall(jsonMode, "api_error", () => client.listResources());
  return (
    (resources.find((r) => r.name === name && r.kind === kind) as Resource | undefined) ?? null
  );
}

/**
 * What the API says already holds the name on a 409 conflict (`existing`):
 * the resource on create, the binding on attach. Null for any other error,
 * or an API too old to say.
 */
function conflictExisting(err: unknown): Record<string, unknown> | null {
  if (!(err instanceof CreekApiError) || err.status !== 409 || err.code !== "conflict") {
    return null;
  }
  const existing = err.details.existing;
  return existing && typeof existing === "object" ? (existing as Record<string, unknown>) : null;
}

/** A detach's 404 for a binding that isn't there (not for a missing project). */
function isMissingBinding(err: unknown): boolean {
  if (!(err instanceof CreekApiError) || err.status !== 404) return false;
  // Older APIs said only `message: "binding"`.
  return err.details.missing === "binding" || err.message === "binding";
}

// Re-running a command must be safe and say what happened. A create or
// attach whose result already exists exactly as asked succeeds with
// `alreadyExists: true` and the existing id; one that clashes with something
// else (another kind, another resource, a deleted name) still fails, with
// what holds the name in `details.existing`. A detach or delete of something
// already gone succeeds with `alreadyAbsent: true`, so an agent retrying
// after a timeout converges instead of seeing a failure; a delete still
// fails `not_found` for a name the team never had, so a typo isn't reported
// as a deletion. Fresh results carry `alreadyExists` / `alreadyAbsent: false`.

export function createResourceCommand(opts: ResourceCmdOptions) {
  const { kind, label, defaultBinding } = opts;
  // What deleting does to the data. Cloudflare deletes a D1 database or KV
  // namespace outright, but refuses to delete an R2 bucket that still holds
  // objects, and such a bucket is not deleted at all, later or otherwise.
  const deletionEffect =
    kind === "storage"
      ? "the bucket is deleted, normally within minutes, if it is empty. A bucket that still holds objects is not deleted and stays, objects included: empty it before deleting it."
      : "the Cloudflare resource and all its data are permanently deleted, normally within minutes (a failed attempt is retried). This cannot be undone.";
  const cmdName = kind === "database" ? "db" : kind === "cache" ? "cache" : kind;

  const ls = defineCommand({
    meta: { name: "ls", description: `List ${label}s in the current team` },
    args: { ...globalArgs },
    async run({ args }) {
      const jsonMode = resolveJsonMode(args);
      const token = requireToken(jsonMode);
      const client = new CreekClient(getApiUrl(), token);

      const { resources } = await apiCall(jsonMode, "api_error", () => client.listResources());
      const filtered = resources.filter((r) => r.kind === kind);

      if (jsonMode)
        jsonOutput({ ok: true, [kind === "database" ? "databases" : kind]: filtered }, 0);

      if (filtered.length === 0) {
        consola.info(`No ${label}s. Run \`creek ${cmdName} create <name>\` to provision one.`);
        return;
      }

      consola.info(`${filtered.length} ${label}(s):\n`);
      for (const r of filtered) {
        const backing = r.cfResourceId
          ? `cf:${r.cfResourceType}/${r.cfResourceId.slice(0, 8)}`
          : "unprovisioned";
        consola.log(`  ${r.name.padEnd(24)}  ${backing}  ${r.status}`);
      }
    },
  });

  const create = defineCommand({
    meta: {
      name: "create",
      description: `Create a new team ${label}. Backing infrastructure is auto-provisioned.`,
    },
    args: {
      name: {
        type: "positional",
        description: `${label} name (lowercase, dash/underscore, ≤63 chars)`,
        required: true,
      },
      ...globalArgs,
    },
    async run({ args }) {
      const jsonMode = resolveJsonMode(args);
      const token = requireToken(jsonMode);
      const client = new CreekClient(getApiUrl(), token);

      try {
        const created = await client.createResource({ kind, name: args.name });
        if (jsonMode) jsonOutput({ ok: true, alreadyExists: false, resource: created }, 0);
        consola.success(`Created ${label} "${created.name}" (${created.id.slice(0, 8)})`);
        consola.info(
          `  Attach with: creek ${cmdName} attach ${created.name} --to <project> --as ${defaultBinding}`,
        );
      } catch (err) {
        const existing = conflictExisting(err);
        if (existing && existing.kind === kind && existing.status !== "deleted") {
          if (jsonMode) jsonOutput({ ok: true, alreadyExists: true, resource: existing }, 0);
          consola.success(
            `${label} "${args.name}" already exists (${String(existing.id).slice(0, 8)}); nothing was created`,
          );
          consola.info(
            `  Attach with: creek ${cmdName} attach ${args.name} --to <project> --as ${defaultBinding}`,
          );
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (jsonMode)
          jsonOutput(
            { ok: false, error: "create_failed", message: msg, ...apiErrorFields(err) },
            1,
          );
        consola.error(msg);
        for (const hint of apiErrorHints(err)) consola.info(hint);
        process.exit(1);
      }
    },
  });

  const attach = defineCommand({
    meta: {
      name: "attach",
      description: `Attach a ${label} to a project under the given ENV var name`,
    },
    args: {
      name: {
        type: "positional",
        description: `${label} name (as shown by \`creek ${cmdName} ls\`)`,
        required: true,
      },
      to: {
        type: "string",
        description: "Project slug to attach to",
        required: true,
        valueHint: "project",
      },
      as: {
        type: "string",
        description: `ENV var name (uppercase, default: ${defaultBinding})`,
        default: defaultBinding,
      },
      ...globalArgs,
    },
    async run({ args }) {
      const jsonMode = resolveJsonMode(args);
      const token = requireToken(jsonMode);
      const client = new CreekClient(getApiUrl(), token);

      const resource = await findByName(client, args.name, kind, jsonMode);
      if (!resource) {
        const msg = `No ${label} named "${args.name}"`;
        if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: msg }, 1);
        consola.error(msg);
        process.exit(1);
      }

      try {
        const binding = await client.attachBinding(args.to, {
          resourceId: resource.id,
          bindingName: args.as,
        });
        if (jsonMode) jsonOutput({ ok: true, alreadyExists: false, binding }, 0);
        consola.success(`Attached "${resource.name}" → ${args.to} as env.${args.as}`);
      } catch (err) {
        const existing = conflictExisting(err);
        if (existing && existing.resourceId === resource.id) {
          const { projectId, bindingName, resourceId, createdAt } = existing;
          if (jsonMode) {
            jsonOutput(
              {
                ok: true,
                alreadyExists: true,
                binding: { projectId, bindingName, resourceId, createdAt },
              },
              0,
            );
          }
          consola.success(
            `"${resource.name}" is already attached to ${args.to} as env.${args.as}; nothing changed`,
          );
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (jsonMode)
          jsonOutput(
            { ok: false, error: "attach_failed", message: msg, ...apiErrorFields(err) },
            1,
          );
        consola.error(msg);
        for (const hint of apiErrorHints(err)) consola.info(hint);
        process.exit(1);
      }
    },
  });

  const detach = defineCommand({
    meta: { name: "detach", description: `Remove a ${label} binding from a project` },
    args: {
      name: { type: "positional", description: `${label} name`, required: true },
      from: { type: "string", description: "Project slug to detach from", required: true },
      as: {
        type: "string",
        description: `ENV var name (default: ${defaultBinding})`,
        default: defaultBinding,
      },
      ...globalArgs,
    },
    async run({ args }) {
      const jsonMode = resolveJsonMode(args);
      const token = requireToken(jsonMode);
      const client = new CreekClient(getApiUrl(), token);

      try {
        await client.detachBinding(args.from, args.as);
        if (jsonMode) jsonOutput({ ok: true, alreadyAbsent: false }, 0);
        consola.success(`Detached env.${args.as} from ${args.from}`);
      } catch (err) {
        if (isMissingBinding(err)) {
          const message = `${args.from} has no binding env.${args.as}; nothing was detached`;
          if (jsonMode) jsonOutput({ ok: true, alreadyAbsent: true, message }, 0);
          consola.success(message);
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (jsonMode)
          jsonOutput(
            { ok: false, error: "detach_failed", message: msg, ...apiErrorFields(err) },
            1,
          );
        consola.error(msg);
        for (const hint of apiErrorHints(err)) consola.info(hint);
        process.exit(1);
      }
    },
  });

  const rename = defineCommand({
    meta: {
      name: "rename",
      description: `Rename a ${label} (stable UUID is preserved; all bindings keep working)`,
    },
    args: {
      name: { type: "positional", description: `Current ${label} name`, required: true },
      to: { type: "string", description: "New name", required: true },
      ...globalArgs,
    },
    async run({ args }) {
      const jsonMode = resolveJsonMode(args);
      const token = requireToken(jsonMode);
      const client = new CreekClient(getApiUrl(), token);

      const resource = await findByName(client, args.name, kind, jsonMode);
      if (!resource) {
        const msg = `No ${label} named "${args.name}"`;
        if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: msg }, 1);
        consola.error(msg);
        process.exit(1);
      }

      try {
        const renamed = await client.renameResource(resource.id, args.to);
        if (jsonMode) jsonOutput({ ok: true, resource: renamed }, 0);
        consola.success(`Renamed "${args.name}" → "${args.to}"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (jsonMode)
          jsonOutput(
            { ok: false, error: "rename_failed", message: msg, ...apiErrorFields(err) },
            1,
          );
        consola.error(msg);
        for (const hint of apiErrorHints(err)) consola.info(hint);
        process.exit(1);
      }
    },
  });

  const del = defineCommand({
    meta: {
      name: "delete",
      description:
        kind === "storage"
          ? `Delete a ${label}; only an empty bucket is removed, so empty it first. Fails if any project still binds to it — detach first.`
          : `Delete a ${label} and its data, permanently. Fails if any project still binds to it — detach first.`,
    },
    args: {
      name: { type: "positional", description: `${label} name`, required: true },
      ...dryRunArg,
      ...globalArgs,
    },
    async run({ args }) {
      const jsonMode = resolveJsonMode(args);
      const token = requireToken(jsonMode);
      const client = new CreekClient(getApiUrl(), token);

      // Deleted resources included: their names stay reserved, so a name
      // that only a deleted resource holds was deleted, not mistyped.
      const { resources } = await apiCall(jsonMode, "api_error", () =>
        client.listResources({ includeDeleted: true }),
      );
      const named = resources.filter((r) => r.name === args.name && r.kind === kind);
      const resource = named.find((r) => r.status !== "deleted");
      if (!resource) {
        const deleted = named[0];
        if (deleted) {
          const message = `${label} "${args.name}" was already deleted; nothing was deleted`;
          if (isDryRun(args)) {
            emitDryRunPlan(jsonMode, {
              command: `creek ${cmdName} delete ${args.name}`,
              wouldExecute: false,
              alreadyAbsent: true,
              resourceId: deleted.id,
              name: args.name,
              kind,
              sideEffects: [],
              nextStep: `creek ${cmdName} ls --json`,
            });
            return;
          }
          if (jsonMode) {
            jsonOutput({ ok: true, alreadyAbsent: true, resource: deleted, message }, 0);
          }
          consola.success(message);
          return;
        }
        const msg = `No ${label} named "${args.name}" in this team; nothing was deleted`;
        if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: msg }, 1);
        consola.error(msg);
        process.exit(1);
      }

      if (isDryRun(args)) {
        const detail = await apiCall(jsonMode, "api_error", () => client.getResource(resource.id));
        const bindings = detail.bindings ?? [];
        const blocked = bindings.length > 0;
        emitDryRunPlan(jsonMode, {
          command: `creek ${cmdName} delete ${args.name}`,
          wouldExecute: !blocked,
          resourceId: resource.id,
          name: args.name,
          kind,
          bindings,
          sideEffects: blocked
            ? bindings.map(
                (b) => `Still bound to ${b.projectSlug} as ${b.bindingName} — detach first`,
              )
            : [`Delete team ${label} "${args.name}": ${deletionEffect}`],
          nextStep: blocked
            ? `creek ${cmdName} detach ${args.name} --from ${bindings[0].projectSlug} --as ${bindings[0].bindingName} --json`
            : `creek ${cmdName} delete ${args.name} --json`,
        });
        return;
      }

      // Destructive and irreversible: confirm in an interactive run unless
      // --yes. Non-TTY (agents/CI) auto-confirms, as elsewhere in the CLI.
      if (!shouldAutoConfirm(args) && isTTY) {
        const ok = (await consola.prompt(
          `Delete ${label} "${args.name}"? ${deletionEffect.charAt(0).toUpperCase()}${deletionEffect.slice(1)}`,
          { type: "confirm" },
        )) as unknown as boolean;
        if (!ok) {
          consola.info("Cancelled.");
          process.exit(0);
        }
      }

      try {
        await client.deleteResource(resource.id);
        if (jsonMode) jsonOutput({ ok: true, alreadyAbsent: false }, 0);
        consola.success(`Deleted ${label} "${args.name}"`);
      } catch (err) {
        // Live a moment ago, gone now: a concurrent delete got there first.
        if (err instanceof CreekApiError && err.status === 404) {
          const message = `${label} "${args.name}" was already deleted; nothing was deleted`;
          if (jsonMode) jsonOutput({ ok: true, alreadyAbsent: true, message }, 0);
          consola.success(message);
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (jsonMode)
          jsonOutput(
            { ok: false, error: "delete_failed", message: msg, ...apiErrorFields(err) },
            1,
          );
        consola.error(msg);
        for (const hint of apiErrorHints(err)) consola.info(hint);
        process.exit(1);
      }
    },
  });

  return defineCommand({
    meta: {
      name: cmdName,
      description: `Manage team-owned ${label}s. Each ${label} is a stable, renameable resource that can be attached to one or more projects.`,
    },
    subCommands: { ls, create, attach, detach, rename, delete: del },
  });
}
