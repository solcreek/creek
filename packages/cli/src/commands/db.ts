/**
 * `creek db` — team-owned database resource management.
 *
 * Terminal + agent-friendly interface to the resources v2 API. Mirrors
 * Heroku's `addons:attach` and Fly.io's `fly postgres attach` models:
 * resources outlive projects, attach to one or many, with a rename-safe
 * stable ID on the server.
 *
 * Subcommands:
 *   creek db ls                          List team databases
 *   creek db create <name>               Create unattached database
 *   creek db attach <name> --to <proj> --as DB
 *   creek db detach <name> --from <proj>
 *   creek db rename <name> --to <new>
 *   creek db delete <name>
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
  kind = "database",
): Promise<Resource | null> {
  const { resources } = await client.listResources();
  return (resources.find((r) => r.name === name && r.kind === kind) as Resource | undefined) ?? null;
}

// --- ls --------------------------------------------------------------

const dbLs = defineCommand({
  meta: {
    name: "ls",
    description: "List databases in the current team",
  },
  args: { ...globalArgs },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = requireToken(jsonMode);
    const client = new CreekClient(getApiUrl(), token);

    const { resources } = await client.listResources();
    const dbs = resources.filter((r) => r.kind === "database");

    if (jsonMode) jsonOutput({ ok: true, databases: dbs }, 0);

    if (dbs.length === 0) {
      consola.info("No databases. Run `creek db create <name>` to provision one.");
      return;
    }

    consola.info(`${dbs.length} database(s):\n`);
    for (const db of dbs) {
      const backing = db.cfResourceId ? `cf:${db.cfResourceType}/${db.cfResourceId.slice(0, 8)}` : "unprovisioned";
      consola.log(`  ${db.name.padEnd(24)}  ${backing}  ${db.status}`);
    }
  },
});

// --- create ----------------------------------------------------------

const dbCreate = defineCommand({
  meta: {
    name: "create",
    description: "Create a new team database resource. Backing CF D1 is provisioned on first bind.",
  },
  args: {
    name: {
      type: "positional",
      description: "Database name (lowercase, dash/underscore, ≤63 chars)",
      required: true,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = requireToken(jsonMode);
    const client = new CreekClient(getApiUrl(), token);

    try {
      const created = await client.createResource({
        kind: "database",
        name: args.name,
      });
      if (jsonMode) jsonOutput({ ok: true, resource: created }, 0);
      consola.success(`Created database "${created.name}" (${created.id.slice(0, 8)})`);
      consola.info(`  Attach with: creek db attach ${created.name} --to <project> --as DB`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonMode) jsonOutput({ ok: false, error: "create_failed", message: msg }, 1);
      consola.error(msg);
      process.exit(1);
    }
  },
});

// --- attach ----------------------------------------------------------

const dbAttach = defineCommand({
  meta: {
    name: "attach",
    description: "Attach a database to a project under the given ENV var name",
  },
  args: {
    name: {
      type: "positional",
      description: "Database name (as shown by `creek db ls`)",
      required: true,
    },
    to: {
      type: "string",
      description: "Project slug to attach to",
      required: true,
    },
    as: {
      type: "string",
      description: "ENV var name (uppercase, default: DB)",
      default: "DB",
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = requireToken(jsonMode);
    const client = new CreekClient(getApiUrl(), token);

    const resource = await findByName(client, args.name);
    if (!resource) {
      const msg = `No database named "${args.name}"`;
      if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: msg }, 1);
      consola.error(msg);
      process.exit(1);
    }

    try {
      const binding = await client.attachBinding(args.to, {
        resourceId: resource.id,
        bindingName: args.as,
      });
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

// --- detach ----------------------------------------------------------

const dbDetach = defineCommand({
  meta: {
    name: "detach",
    description: "Remove a database binding from a project",
  },
  args: {
    name: {
      type: "positional",
      description: "Database name",
      required: true,
    },
    from: {
      type: "string",
      description: "Project slug to detach from",
      required: true,
    },
    as: {
      type: "string",
      description: "ENV var name (default: DB). Needed when a project binds the same db under multiple names.",
      default: "DB",
    },
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

// --- rename ----------------------------------------------------------

const dbRename = defineCommand({
  meta: {
    name: "rename",
    description: "Rename a database (stable UUID is preserved; all bindings keep working)",
  },
  args: {
    name: {
      type: "positional",
      description: "Current database name",
      required: true,
    },
    to: {
      type: "string",
      description: "New name",
      required: true,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = requireToken(jsonMode);
    const client = new CreekClient(getApiUrl(), token);

    const resource = await findByName(client, args.name);
    if (!resource) {
      const msg = `No database named "${args.name}"`;
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

// --- delete ----------------------------------------------------------

const dbDelete = defineCommand({
  meta: {
    name: "delete",
    description: "Delete a database. Fails if any project still binds to it — detach first.",
  },
  args: {
    name: {
      type: "positional",
      description: "Database name",
      required: true,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = requireToken(jsonMode);
    const client = new CreekClient(getApiUrl(), token);

    const resource = await findByName(client, args.name);
    if (!resource) {
      const msg = `No database named "${args.name}"`;
      if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: msg }, 1);
      consola.error(msg);
      process.exit(1);
    }

    try {
      await client.deleteResource(resource.id);
      if (jsonMode) jsonOutput({ ok: true }, 0);
      consola.success(`Deleted database "${args.name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonMode) jsonOutput({ ok: false, error: "delete_failed", message: msg }, 1);
      consola.error(msg);
      process.exit(1);
    }
  },
});

// --- main ------------------------------------------------------------

export const dbCommand = defineCommand({
  meta: {
    name: "db",
    description:
      "Manage team-owned databases. Each database is a stable, renameable resource that can be attached to one or more projects. Use this instead of wrangler d1 — Creek handles CF provisioning and your code reads env.DB regardless.",
  },
  subCommands: {
    ls: dbLs,
    create: dbCreate,
    attach: dbAttach,
    detach: dbDetach,
    rename: dbRename,
    delete: dbDelete,
  },
});
