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
import { CreekClient } from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import {
  globalArgs,
  resolveJsonMode,
  jsonOutput,
  AUTH_BREADCRUMBS,
} from "../utils/output.js";

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
    if (jsonMode) jsonOutput({ ok: false, error: "not_authenticated" }, 1, AUTH_BREADCRUMBS);
    consola.error("Not authenticated. Run `creek login` first.");
    process.exit(1);
  }
  return token;
}

async function findByName(
  client: CreekClient,
  name: string,
  kind: string,
): Promise<Resource | null> {
  const { resources } = await client.listResources();
  return (resources.find((r) => r.name === name && r.kind === kind) as Resource | undefined) ?? null;
}

export function createResourceCommand(opts: ResourceCmdOptions) {
  const { kind, label, defaultBinding } = opts;
  const cmdName = kind === "database" ? "db" : kind === "cache" ? "cache" : kind;

  const ls = defineCommand({
    meta: { name: "ls", description: `List ${label}s in the current team` },
    args: { ...globalArgs },
    async run({ args }) {
      const jsonMode = resolveJsonMode(args);
      const token = requireToken(jsonMode);
      const client = new CreekClient(getApiUrl(), token);

      const { resources } = await client.listResources();
      const filtered = resources.filter((r) => r.kind === kind);

      if (jsonMode) jsonOutput({ ok: true, [kind === "database" ? "databases" : kind]: filtered }, 0);

      if (filtered.length === 0) {
        consola.info(`No ${label}s. Run \`creek ${cmdName} create <name>\` to provision one.`);
        return;
      }

      consola.info(`${filtered.length} ${label}(s):\n`);
      for (const r of filtered) {
        const backing = r.cfResourceId ? `cf:${r.cfResourceType}/${r.cfResourceId.slice(0, 8)}` : "unprovisioned";
        consola.log(`  ${r.name.padEnd(24)}  ${backing}  ${r.status}`);
      }
    },
  });

  const create = defineCommand({
    meta: { name: "create", description: `Create a new team ${label}. Backing CF resource is auto-provisioned.` },
    args: {
      name: { type: "positional", description: `${label} name (lowercase, dash/underscore, ≤63 chars)`, required: true },
      ...globalArgs,
    },
    async run({ args }) {
      const jsonMode = resolveJsonMode(args);
      const token = requireToken(jsonMode);
      const client = new CreekClient(getApiUrl(), token);

      try {
        const created = await client.createResource({ kind, name: args.name });
        if (jsonMode) jsonOutput({ ok: true, resource: created }, 0);
        consola.success(`Created ${label} "${created.name}" (${created.id.slice(0, 8)})`);
        consola.info(`  Attach with: creek ${cmdName} attach ${created.name} --to <project> --as ${defaultBinding}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (jsonMode) jsonOutput({ ok: false, error: "create_failed", message: msg }, 1);
        consola.error(msg);
        process.exit(1);
      }
    },
  });

  const attach = defineCommand({
    meta: { name: "attach", description: `Attach a ${label} to a project under the given ENV var name` },
    args: {
      name: { type: "positional", description: `${label} name (as shown by \`creek ${cmdName} ls\`)`, required: true },
      to: { type: "string", description: "Project slug to attach to", required: true },
      as: { type: "string", description: `ENV var name (uppercase, default: ${defaultBinding})`, default: defaultBinding },
      ...globalArgs,
    },
    async run({ args }) {
      const jsonMode = resolveJsonMode(args);
      const token = requireToken(jsonMode);
      const client = new CreekClient(getApiUrl(), token);

      const resource = await findByName(client, args.name, kind);
      if (!resource) {
        const msg = `No ${label} named "${args.name}"`;
        if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: msg }, 1);
        consola.error(msg);
        process.exit(1);
      }

      try {
        const binding = await client.attachBinding(args.to, { resourceId: resource.id, bindingName: args.as });
        if (jsonMode) jsonOutput({ ok: true, binding }, 0);
        consola.success(`Attached "${resource.name}" → ${args.to} as env.${args.as}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (jsonMode) jsonOutput({ ok: false, error: "attach_failed", message: msg }, 1);
        consola.error(msg);
        process.exit(1);
      }
    },
  });

  const detach = defineCommand({
    meta: { name: "detach", description: `Remove a ${label} binding from a project` },
    args: {
      name: { type: "positional", description: `${label} name`, required: true },
      from: { type: "string", description: "Project slug to detach from", required: true },
      as: { type: "string", description: `ENV var name (default: ${defaultBinding})`, default: defaultBinding },
      ...globalArgs,
    },
    async run({ args }) {
      const jsonMode = resolveJsonMode(args);
      const token = requireToken(jsonMode);
      const client = new CreekClient(getApiUrl(), token);

      try {
        await client.detachBinding(args.from, args.as);
        if (jsonMode) jsonOutput({ ok: true }, 0);
        consola.success(`Detached env.${args.as} from ${args.from}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (jsonMode) jsonOutput({ ok: false, error: "detach_failed", message: msg }, 1);
        consola.error(msg);
        process.exit(1);
      }
    },
  });

  const rename = defineCommand({
    meta: { name: "rename", description: `Rename a ${label} (stable UUID is preserved; all bindings keep working)` },
    args: {
      name: { type: "positional", description: `Current ${label} name`, required: true },
      to: { type: "string", description: "New name", required: true },
      ...globalArgs,
    },
    async run({ args }) {
      const jsonMode = resolveJsonMode(args);
      const token = requireToken(jsonMode);
      const client = new CreekClient(getApiUrl(), token);

      const resource = await findByName(client, args.name, kind);
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
        if (jsonMode) jsonOutput({ ok: false, error: "rename_failed", message: msg }, 1);
        consola.error(msg);
        process.exit(1);
      }
    },
  });

  const del = defineCommand({
    meta: { name: "delete", description: `Delete a ${label}. Fails if any project still binds to it — detach first.` },
    args: {
      name: { type: "positional", description: `${label} name`, required: true },
      ...globalArgs,
    },
    async run({ args }) {
      const jsonMode = resolveJsonMode(args);
      const token = requireToken(jsonMode);
      const client = new CreekClient(getApiUrl(), token);

      const resource = await findByName(client, args.name, kind);
      if (!resource) {
        const msg = `No ${label} named "${args.name}"`;
        if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: msg }, 1);
        consola.error(msg);
        process.exit(1);
      }

      try {
        await client.deleteResource(resource.id);
        if (jsonMode) jsonOutput({ ok: true }, 0);
        consola.success(`Deleted ${label} "${args.name}"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (jsonMode) jsonOutput({ ok: false, error: "delete_failed", message: msg }, 1);
        consola.error(msg);
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
