/**
 * Resource provisioning + binding assembly for the deploy pipeline.
 *
 * Operates on the `resource` + `project_resource_binding` tables.
 * Resources are team-owned; projects reference them via bindings.
 *
 * The deploy pipeline calls `ensureProjectBindings()` which:
 *   1. Reads existing bindings from `project_resource_binding`
 *   2. For any binding requirement from the CLI bundle that has no
 *      matching row, auto-creates a team-owned resource + binding
 *   3. Provisions CF resources (D1/R2/KV) if `cfResourceId` is null
 *   4. Returns the resolved bindings, which `buildBindings()` turns into the
 *      `WfPBinding[]` the Workers for Platforms API takes
 *
 * Every check that a binding's resource is of the type the deploy expects
 * goes through `planBindings()`, before anything is written.
 */

import type { Env } from "../../types.js";
import {
  BINDING_NAMES,
  DEPRECATED_ALIAS_TYPES,
  DEPRECATED_BINDING_ALIASES,
  INTERNAL_VARS,
  deprecatedAliasBindings,
} from "@solcreek/sdk";
import {
  provisionCFResource,
  findExistingCFResource,
  createQueue,
  getQueue,
  setQueueConsumer,
} from "./cloudflare.js";

// --- Types ---

export interface WfPBinding {
  type: string;
  name: string;
  [key: string]: unknown;
}

/** The binding types a deploy binds from the bundle's requirements. */
export type BindingType = "d1" | "r2" | "kv" | "ai";

/** Binding requirement from the CLI bundle */
export interface BundleBindingRequirement {
  type: BindingType;
  bindingName: string;
}

/**
 * A binding resolved for the worker. Workers AI is account-level: it has no
 * Cloudflare resource id, only a name.
 */
export interface ResolvedResourceBinding {
  bindingName: string;
  cfType: BindingType;
  cfResourceId: string | null;
}

/** A resolved resource row from the `resource` table */
interface ResourceRow {
  id: string;
  teamId: string;
  kind: string;
  name: string;
  cfResourceId: string | null;
  cfResourceType: string | null;
  status: string;
}

/** A resolved binding from `project_resource_binding` joined with `resource` */
interface ResolvedBinding {
  bindingName: string;
  resourceId: string;
  kind: string;
  cfResourceId: string | null;
  cfResourceType: string | null;
}

// --- Kind / CF type mapping ---

const KIND_TO_CF: Record<string, string> = {
  database: "d1",
  storage: "r2",
  cache: "kv",
};

const CF_TO_KIND: Record<string, string> = {
  d1: "database",
  r2: "storage",
  kv: "cache",
  ai: "ai",
};

/** What each resource kind binds as. */
const KIND_TO_BINDING_TYPE: Record<string, string> = {
  ...KIND_TO_CF,
  ai: "ai",
  queue: "queue",
};

const BINDING_TYPES: ReadonlySet<string> = new Set<BindingType>(["d1", "r2", "kv", "ai"]);

/** Whether a deploy binds requirements of this type. */
export function isBindingType(type: string): type is BindingType {
  return BINDING_TYPES.has(type);
}

/**
 * What a resource binds as: its stored Cloudflare type, else its kind's
 * (resources created through the API, Workers AI among them, may have no
 * stored type). Null when the two disagree or neither is known, so such a
 * row matches no requirement rather than being guessed at.
 */
export function resourceBindingType(row: {
  kind: string;
  cfResourceType: string | null;
}): string | null {
  const fromKind = KIND_TO_BINDING_TYPE[row.kind] ?? null;
  if (row.cfResourceType && fromKind && row.cfResourceType !== fromKind) return null;
  return row.cfResourceType ?? fromKind;
}

// --- Core: ensure bindings for deploy ---

/** A deploy that may only use existing bindings declared a new one. */
export class BindingNotAllowedError extends Error {
  constructor(public readonly bindingName: string) {
    super(
      `This deploy cannot add ${bindingName} to the project: it may only use bindings the project already has (a preview deploy by a key without resource:write)`,
    );
    this.name = "BindingNotAllowedError";
  }
}

/** A deploy whose bindings contradict each other or the project's bindings. */
export class BindingConflictError extends Error {
  constructor(public readonly conflicts: readonly string[]) {
    super(conflicts.join(" "));
    this.name = "BindingConflictError";
  }
}

/** "a database resource", "an ai resource". */
function aResource(kind: string): string {
  return `${/^[aeiou]/i.test(kind) ? "an" : "a"} ${kind} resource`;
}

const PROJECT_BINDINGS_SQL = `SELECT b.bindingName, b.resourceId, r.kind, r.cfResourceId, r.cfResourceType
     FROM project_resource_binding b
     JOIN resource r ON b.resourceId = r.id
     WHERE b.projectId = ?`;

/** What a deploy would do to a project's bindings, decided before any write. */
export interface BindingPlan {
  /** The requirements the deploy binds: supported types, one per name. */
  requirements: BundleBindingRequirement[];
  /** Requirements of a type deploys do not bind. Skipped. */
  unsupported: { type: string; bindingName: string }[];
  /** Binding names the deploy adds to the project. */
  added: string[];
  /** Why the deploy cannot bind as declared. Any at all: it binds nothing. */
  conflicts: string[];
}

/**
 * The one definition of what a deploy binds, used by both the upload check
 * (planDeployBindings) and the deploy job (ensureProjectBindings, which also
 * decides ensureQueue's QUEUE), so the two cannot disagree. Pure: decides
 * from the project's binding rows as read.
 *
 * - Every binding is keyed by its name, Workers AI included: a requirement
 *   binds the name it declares.
 * - A requirement whose name is bound must match the bound resource's type
 *   (resourceBindingType); anything else is a conflict. So is one name
 *   declared with two types and, when the bundle wants a queue, a
 *   requirement named QUEUE or a resource other than a queue bound as QUEUE.
 * - A requirement whose name is not bound (a binding whose resource row is
 *   gone counts as unbound) is added: ensureProjectBindings creates a
 *   resource for it, or adopts a deprecated alias's resource under it. A
 *   bound name is not, even when its Cloudflare resource is not provisioned
 *   yet: someone already attached it.
 * - wantsQueue adds QUEUE when nothing is bound under QUEUE (ensureQueue).
 * - A requirement of a type deploys do not bind (a framework adapter's
 *   IMAGES, say) is skipped: never added or bound. Its name stays reserved,
 *   so the worker never gets something else under it: two types under one
 *   name, QUEUE beside the queue, a resource attached under the name, or a
 *   deprecated alias the deploy emits under it are all conflicts.
 * - Text bindings (`text`: environment variables for the deploy's target,
 *   the config's [vars]) and Creek's CREEK_* values share the worker's env:
 *   a name used by two of them, or by one of them and a resource binding,
 *   is a conflict.
 */
export function planBindings(
  existing: readonly { bindingName: string; kind: string; cfResourceType: string | null }[],
  requirements: readonly { bindingName: string; type?: string }[],
  wantsQueue: boolean,
  text: TextBindingNames = {},
): BindingPlan {
  const bound = new Map(existing.map((r) => [r.bindingName, r]));
  const plan: BindingPlan = { requirements: [], unsupported: [], added: [], conflicts: [] };

  // Every declaration, of a type deploys bind or not, takes part in the name
  // checks: one name is one binding. Only supported ones are bound.
  const declared = new Map<string, string>();
  for (const req of requirements) {
    const type = req.type ?? "";
    const earlier = declared.get(req.bindingName);
    if (earlier !== undefined) {
      if (earlier !== type) {
        plan.conflicts.push(
          `${req.bindingName} is declared as both ${earlier || "untyped"} and ${type || "untyped"}. Give each binding its own name.`,
        );
      }
      continue;
    }
    declared.set(req.bindingName, type);
    if (isBindingType(type)) plan.requirements.push({ type, bindingName: req.bindingName });
    else plan.unsupported.push({ type, bindingName: req.bindingName });
  }

  for (const req of plan.requirements) {
    const row = bound.get(req.bindingName);
    if (!row) {
      plan.added.push(req.bindingName);
    } else if (resourceBindingType(row) !== req.type) {
      plan.conflicts.push(
        `${req.bindingName} is attached to ${aResource(row.kind)}, but the bundle declares it as ${req.type}. Detach it or rename the binding.`,
      );
    }
  }

  // A skipped declaration still names something the app reads, so its name
  // stays reserved. Any resource attached under it conflicts, whether or not
  // this deploy would bind it (provisioned D1/R2/KV attachments are bound
  // undeclared; Workers AI, queues and unprovisioned rows are not yet, but
  // the project has given the name to them). So does a deprecated alias
  // (DB, KV) of a primary of the alias's own type, declared or attached.
  const aliasOf = new Map<string, string>();
  const primaries = [
    ...plan.requirements.map((r) => ({ name: r.bindingName, type: r.type as string | null })),
    ...existing
      .filter((r) => !declared.has(r.bindingName))
      .map((r) => ({ name: r.bindingName, type: resourceBindingType(r) })),
  ];
  for (const { name, type } of primaries) {
    const alias = DEPRECATED_BINDING_ALIASES[name];
    if (alias && type !== null && DEPRECATED_ALIAS_TYPES[name] === type) aliasOf.set(alias, name);
  }
  for (const skipped of plan.unsupported) {
    const what = skipped.type || "untyped";
    const row = bound.get(skipped.bindingName);
    const primary = aliasOf.get(skipped.bindingName);
    if (row) {
      plan.conflicts.push(
        `${skipped.bindingName} is attached to ${aResource(row.kind)}, but the bundle declares it as ${what}, which deploys do not bind. Detach it or rename the binding.`,
      );
    } else if (primary) {
      plan.conflicts.push(
        `${skipped.bindingName} is bound as the deprecated alias of ${primary}, but the bundle declares it as ${what}, which deploys do not bind. Rename the binding.`,
      );
    }
  }

  if (wantsQueue) {
    const queue = BINDING_NAMES.queue;
    const row = bound.get(queue);
    if (declared.has(queue)) {
      plan.conflicts.push(
        `${queue} is the queue's binding, but the bundle also declares it as ${declared.get(queue) || "untyped"}. Rename that binding.`,
      );
    } else if (!row) {
      plan.added.push(queue);
    } else if (resourceBindingType(row) !== "queue") {
      plan.conflicts.push(
        `${queue} is attached to ${aResource(row.kind)}, not a queue. Detach it or rename that binding.`,
      );
    }
  }

  // Text bindings share the worker's env with everything above: project
  // environment variables (secret_text) and the config's [vars]
  // (plain_text), beside Creek's own CREEK_* values. Two bindings under one
  // name fail the Workers upload, after resources have been created, so
  // refuse the name here. Resource names count as the skipped-name rule
  // does: anything declared, attached, an alias the deploy emits, or the
  // queue.
  const reserved = new Set<string>(Object.values(INTERNAL_VARS));
  const resourceNames = new Set<string>([
    ...declared.keys(),
    ...bound.keys(),
    ...aliasOf.keys(),
    ...(wantsQueue ? [BINDING_NAMES.queue] : []),
  ]);
  for (const name of resourceNames) {
    if (reserved.has(name)) {
      plan.conflicts.push(`${name} is a name Creek sets on every worker. Rename the binding.`);
    }
  }
  const envKeys = new Set(text.envKeys ?? []);
  for (const key of envKeys) {
    if (reserved.has(key)) {
      plan.conflicts.push(
        `${key} is a name Creek sets on every worker, but the project has an environment variable named ${key}. Remove it (\`creek env rm ${key}\`).`,
      );
    } else if (resourceNames.has(key)) {
      plan.conflicts.push(
        `${key} is both a binding and a project environment variable. Rename one (\`creek env rm ${key}\`, then set it under another name).`,
      );
    }
  }
  for (const key of new Set(text.varKeys ?? [])) {
    if (reserved.has(key)) {
      plan.conflicts.push(
        `${key} is a name Creek sets on every worker, but the config's [vars] declares it. Rename it.`,
      );
    } else if (resourceNames.has(key)) {
      plan.conflicts.push(`${key} is both a binding and a [vars] value in the config. Rename one.`);
    } else if (envKeys.has(key)) {
      plan.conflicts.push(
        `${key} is both a project environment variable and a [vars] value in the config. Keep one: remove the variable (\`creek env rm ${key}\`) or the [vars] entry.`,
      );
    }
  }
  return plan;
}

/**
 * The names of a deploy's text bindings, which share the worker's env with
 * its resource bindings: the project's environment variables for the
 * deploy's target, and the config's [vars].
 */
export interface TextBindingNames {
  envKeys?: readonly string[];
  varKeys?: readonly string[];
}

/** planBindings against the project's current bindings. Read-only. */
export async function planDeployBindings(
  env: Env,
  projectId: string,
  requirements: readonly { bindingName: string; type?: string }[],
  wantsQueue: boolean,
  text: TextBindingNames = {},
): Promise<BindingPlan> {
  const rows = await env.DB.prepare(PROJECT_BINDINGS_SQL).bind(projectId).all<ResolvedBinding>();
  return planBindings(rows.results, requirements, wantsQueue, text);
}

/**
 * Resolves bindings from two sources:
 *   - Server-side attachments (`creek <kind> attach`): every existing
 *     d1/r2/kv `project_resource_binding` with a provisioned CF resource is
 *     bound, so an attached resource reaches the worker even when the bundle's
 *     config doesn't declare it. (Queues are wired separately; Workers AI is
 *     bound only when declared.)
 *   - The CLI bundle's requirements: for each, reuse the existing binding
 *     (provisioning CF if needed) or auto-create a resource + binding.
 *     A requirement overrides a server attachment of the same name.
 *
 * Refuses, before any write, a deploy planBindings finds a conflict in, and
 * with mayAddBindings=false one that would add a binding. wantsQueue is the
 * bundle's queue, which ensureQueue then provisions: passing it here checks
 * QUEUE with everything else, before anything is created.
 *
 * Returns resolved bindings keyed by binding name.
 */
export async function ensureProjectBindings(
  env: Env,
  projectId: string,
  teamId: string,
  requirements: readonly { bindingName: string; type?: string }[],
  opts: { mayAddBindings?: boolean; wantsQueue?: boolean; text?: TextBindingNames } = {},
): Promise<Map<string, ResolvedResourceBinding>> {
  const mayAddBindings = opts.mayAddBindings !== false;
  // Fetch existing bindings for this project
  const existingRows = await env.DB.prepare(PROJECT_BINDINGS_SQL)
    .bind(projectId)
    .all<ResolvedBinding>();

  const plan = planBindings(
    existingRows.results,
    requirements,
    opts.wantsQueue === true,
    opts.text,
  );
  if (plan.conflicts.length > 0) throw new BindingConflictError(plan.conflicts);
  // Refuse before any write, with the same decision the upload check made.
  // The throw at the alias/create point below stays as a second line in case
  // this function's branches ever drift from it.
  if (!mayAddBindings && plan.added.length > 0) {
    throw new BindingNotAllowedError(plan.added.join(", "));
  }

  const existingByName = new Map(existingRows.results.map((b) => [b.bindingName, b]));

  const result = new Map<string, ResolvedResourceBinding>();

  // Seed with server-side attachments that already have a provisioned CF
  // resource: D1/R2/KV. Requirements below override these by binding name.
  // Skip a row whose type can't be determined rather than guessing — a wrong
  // guess would mis-bind the resource (e.g. a non-KV resource as KV). Workers
  // AI is bound only while the bundle declares it, as before: account-level
  // usage stays tied to the app's own config.
  for (const existing of existingRows.results) {
    const cfType = resourceBindingType(existing);
    if (cfType !== "d1" && cfType !== "r2" && cfType !== "kv") continue;
    if (!existing.cfResourceId) continue;
    result.set(existing.bindingName, {
      bindingName: existing.bindingName,
      cfType,
      cfResourceId: existing.cfResourceId,
    });
  }

  for (const req of plan.requirements) {
    const existing = existingByName.get(req.bindingName);

    if (existing) {
      // Bound already, to a resource of the declared type (planBindings
      // refused any other). Workers AI is account-level: nothing to provision.
      if (req.type === "ai" || existing.cfResourceId) {
        result.set(req.bindingName, {
          bindingName: req.bindingName,
          cfType: req.type,
          cfResourceId: req.type === "ai" ? null : existing.cfResourceId,
        });
        continue;
      }

      // Binding exists but CF resource not yet provisioned — provision now
      const cfName = `creek-${existing.resourceId.slice(0, 8)}`;
      const cfType = req.type;
      const cfId =
        (await findExistingCFResource(env, cfType, cfName)) ??
        (await provisionCFResource(env, cfType, cfName));

      await env.DB.prepare(
        `UPDATE resource SET cfResourceId = ?, cfResourceType = ?, status = 'active', updatedAt = ?
         WHERE id = ?`,
      )
        .bind(cfId, cfType, Date.now(), existing.resourceId)
        .run();

      result.set(req.bindingName, {
        bindingName: req.bindingName,
        cfType,
        cfResourceId: cfId,
      });
      continue;
    }

    // Migration safety: this requirement's exact name isn't bound, but if it's
    // a PRIMARY name (e.g. DATABASE) whose DEPRECATED ALIAS (e.g. DB) is already
    // bound to a provisioned resource, adopt that resource under the primary
    // name too — never provision a fresh (empty) one. Without this, a project
    // first deployed under the old name (DB) that now deploys under the new
    // primary (DATABASE) gets a SECOND, empty database bound as DATABASE while
    // its data stays in DB: a split-brain across two D1s.
    // Past this point the requirement's name is not bound: binding it (by
    // adopting an alias's resource or creating one) changes the project.
    if (!mayAddBindings) throw new BindingNotAllowedError(req.bindingName);

    const aliasName = DEPRECATED_BINDING_ALIASES[req.bindingName];
    const aliasBinding = aliasName ? existingByName.get(aliasName) : undefined;
    // Only adopt when the alias's resource TYPE matches the requirement — a
    // user could have named an unrelated resource with the alias (e.g.
    // `creek storage attach --as DB`), and blindly adopting it would silently
    // bind DATABASE to an R2/KV. On a type mismatch, fall through to auto-create.
    if (
      aliasBinding &&
      aliasBinding.cfResourceId &&
      resourceBindingType(aliasBinding) === req.type
    ) {
      // Bind only while the resource is still live, in one statement: the
      // alias could be detached and the resource deleted (its Cloudflare
      // resource queued for teardown) since it was read above. If so, fall
      // through to creating a fresh resource rather than binding the old one.
      const adopted = await env.DB.prepare(
        `INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt)
         SELECT ?, ?, id, ? FROM resource WHERE id = ? AND status != 'deleted'
         ON CONFLICT(projectId, bindingName) DO UPDATE SET resourceId = excluded.resourceId`,
      )
        .bind(projectId, req.bindingName, Date.now(), aliasBinding.resourceId)
        .run();
      if (adopted.meta.changes) {
        result.set(req.bindingName, {
          bindingName: req.bindingName,
          cfType: req.type,
          cfResourceId: aliasBinding.cfResourceId,
        });
        continue;
      }
      // Gone: also drop the alias's own entry, seeded above from the
      // bindings read earlier, so the worker isn't bound to it either.
      if (aliasName) result.delete(aliasName);
    }

    // No binding exists — auto-create resource + binding
    const resourceId = crypto.randomUUID();
    const cfName = `creek-${resourceId.slice(0, 8)}`;
    const kind = CF_TO_KIND[req.type];
    const cfType = req.type;
    const now = Date.now();

    // Provision CF resource (Workers AI has none)
    let cfId: string | null = null;
    if (cfType !== "ai") {
      cfId =
        (await findExistingCFResource(env, cfType, cfName)) ??
        (await provisionCFResource(env, cfType, cfName));
    }

    // Insert the resource row and its binding together. Apart, a
    // DELETE /resources/:id landing between them would find the new resource
    // unbound, delete it and queue its Cloudflare resource for teardown,
    // under the binding this deploy then adds.
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        ).bind(resourceId, teamId, kind, cfName, cfId, cfType, now, now),
        env.DB.prepare(
          `INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt)
           VALUES (?, ?, ?, ?)`,
        ).bind(projectId, req.bindingName, resourceId, now),
      ]);
    } catch (err) {
      if (cfId) await queueRolledBackResource(env, cfType, cfId, cfName);
      throw err;
    }

    result.set(req.bindingName, { bindingName: req.bindingName, cfType, cfResourceId: cfId });
  }

  return result;
}

// --- Queue provisioning ---

/**
 * Ensure a queue resource exists for a project.
 * Returns the CF queue ID + name.
 */
export async function ensureQueue(
  env: Env,
  projectId: string,
  teamId: string,
  opts: { mayAddBindings?: boolean } = {},
): Promise<{ cfResourceId: string; cfResourceName: string }> {
  // Check for existing queue binding
  const existing = await env.DB.prepare(
    `SELECT b.resourceId, r.kind, r.cfResourceId, r.cfResourceType
     FROM project_resource_binding b
     JOIN resource r ON b.resourceId = r.id
     WHERE b.projectId = ? AND b.bindingName = ?`,
  )
    .bind(projectId, BINDING_NAMES.queue)
    .first<{
      resourceId: string;
      kind: string;
      cfResourceId: string | null;
      cfResourceType: string | null;
    }>();

  // Another kind of resource attached as QUEUE is not a queue: using its id
  // as one, or writing a new queue's id onto its row, would break it (and
  // every project bound to it). Refuse instead. ensureProjectBindings
  // (planBindings) refuses this first, before anything is created; this
  // check guards a binding attached since.
  if (existing && resourceBindingType(existing) !== "queue") {
    throw new Error(
      `Binding ${BINDING_NAMES.queue} is attached to ${aResource(existing.kind)}, not a queue. Detach it or rename that binding.`,
    );
  }

  if (existing?.cfResourceId) {
    const name = `creek-q-${existing.resourceId.slice(0, 8)}`;
    return { cfResourceId: existing.cfResourceId, cfResourceName: name };
  }

  if (!existing && opts.mayAddBindings === false) {
    throw new BindingNotAllowedError(BINDING_NAMES.queue);
  }

  // Create queue resource
  const resourceId = existing?.resourceId ?? crypto.randomUUID();
  const queueName = `creek-q-${resourceId.slice(0, 8)}`;
  const now = Date.now();

  let queueId = await getQueue(env, queueName);
  if (!queueId) {
    queueId = await createQueue(env, queueName);
  }

  if (!existing) {
    // Insert resource + binding, together (see the d1/r2/kv path above).
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
           VALUES (?, ?, 'queue', ?, ?, 'queue', 'active', ?, ?)`,
        ).bind(resourceId, teamId, queueName, queueId, now, now),
        env.DB.prepare(
          `INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt)
           VALUES (?, ?, ?, ?)`,
        ).bind(projectId, BINDING_NAMES.queue, resourceId, now),
      ]);
    } catch (err) {
      await queueRolledBackResource(env, "queue", queueId, queueName);
      throw err;
    }
  } else {
    // Update existing resource with CF ID
    await env.DB.prepare(
      `UPDATE resource SET cfResourceId = ?, status = 'active', updatedAt = ? WHERE id = ?`,
    )
      .bind(queueId, now, existing.resourceId)
      .run();
  }

  return { cfResourceId: queueId, cfResourceName: queueName };
}

// --- Binding assembly ---

/**
 * Build WfP bindings array from resolved resources.
 */
export function buildBindings(
  resolvedBindings: Map<string, ResolvedResourceBinding>,
  envVars: { key: string; value: string }[],
  options: {
    projectSlug: string;
    projectId: string;
    realtimeUrl: string;
    realtimeSecret?: string;
    queueName?: string;
  },
): WfPBinding[] {
  const bindings: WfPBinding[] = [];

  const seen = new Set<string>();
  const emit = (name: string, resolved: ResolvedResourceBinding): void => {
    switch (resolved.cfType) {
      // Workers AI is account-level: bound under the declared name, with no
      // per-tenant resource.
      case "ai":
        bindings.push({ type: "ai", name });
        break;
      case "d1":
        bindings.push({ type: "d1", name, id: resolved.cfResourceId });
        break;
      case "r2":
        bindings.push({
          type: "r2_bucket",
          name,
          bucket_name: resolved.cfResourceId,
        });
        break;
      case "kv":
        bindings.push({
          type: "kv_namespace",
          name,
          namespace_id: resolved.cfResourceId,
        });
        break;
    }
  };

  // Primary names first — they always win over a deprecated alias of the same
  // name (resolvedBindings is keyed by binding name, so primaries are unique).
  for (const [, resolved] of resolvedBindings) {
    emit(resolved.bindingName, resolved);
    seen.add(resolved.bindingName);
  }

  // Deprecated aliases (e.g. DB for DATABASE) pointing at the same resource,
  // so Workers reading the old CF-primitive name keep working through the
  // v1.0 window — but only when the alias name isn't already taken, to avoid
  // duplicate Worker env binding names. Shared with sandbox provisioning so a
  // preview binds the same names.
  for (const alias of deprecatedAliasBindings(bindings)) {
    bindings.push(alias);
    seen.add(alias.name);
  }

  // Queue producer binding
  if (options.queueName) {
    bindings.push({
      type: "queue",
      name: BINDING_NAMES.queue,
      queue_name: options.queueName,
    });
  }

  // Internal vars
  bindings.push({
    type: "plain_text",
    name: INTERNAL_VARS.projectSlug,
    text: options.projectSlug,
  });

  // Stable UUID — adapter-creek uses this to derive per-tenant DO IDs
  // for ISR cache isolation across projects sharing Creek's WfP dispatch
  // namespace. Without this, two projects' cache entries could collide
  // via DO idFromName().
  bindings.push({
    type: "plain_text",
    name: INTERNAL_VARS.projectId,
    text: options.projectId,
  });

  bindings.push({
    type: "plain_text",
    name: INTERNAL_VARS.realtimeUrl,
    text: options.realtimeUrl,
  });

  if (options.realtimeSecret) {
    bindings.push({
      type: "secret_text",
      name: INTERNAL_VARS.realtimeSecret,
      text: options.realtimeSecret,
    });
  }

  // User-defined environment variables
  for (const envVar of envVars) {
    bindings.push({
      type: "secret_text",
      name: envVar.key,
      text: envVar.value,
    });
  }

  return bindings;
}

// --- Cleanup ---

/**
 * Queue a Cloudflare resource this code just provisioned for teardown, when
 * the transaction that would have recorded it rolled back (for example, a
 * concurrent deploy bound the same name first). Without this nothing would
 * reference it, and nothing would ever delete it. Queued under the name it
 * was provisioned with, which the cleanup checks before deleting.
 * Best-effort: the caller is already failing with the original error.
 */
async function queueRolledBackResource(
  env: Env,
  cfType: string,
  cfId: string,
  cfName: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO resource_cleanup_queue (resourceType, cfResourceId, cfResourceName, status, reason, createdAt)
       VALUES (?, ?, ?, 'pending', 'provision_rolled_back', ?)`,
    )
      .bind(cfType, cfId, cfName, Math.floor(Date.now() / 1000))
      .run();
  } catch (err) {
    console.error(`[resources] could not queue rolled-back ${cfType} ${cfId} for cleanup:`, err);
  }
}

/**
 * The statement that schedules a deleted project's Cloudflare cleanup, for
 * the caller to run in the same batch as the project's deletion: queued and
 * deleted together, or neither.
 *
 * Copies resource info into `resource_cleanup_queue` for async CF
 * resource deletion. The actual `project_resource_binding` rows are
 * deleted via ON DELETE CASCADE when the project row is removed.
 *
 * Note: resources themselves are NOT deleted — they're team-owned and
 * may be bound to other projects. Only the bindings are removed. If the
 * resource has no remaining bindings after project deletion, it becomes
 * "unattached" but stays alive until explicitly deleted via the API.
 */
export function projectCleanupStatement(env: Env, projectId: string): D1PreparedStatement {
  // Queue custom domain hostnames for CF cleanup
  // createdAt is NOT NULL, in seconds (drizzle `timestamp` mode).
  return env.DB.prepare(
    `INSERT INTO resource_cleanup_queue (resourceType, cfResourceId, cfResourceName, status, reason, createdAt)
     SELECT 'custom_hostname', cfCustomHostnameId, hostname, 'pending', 'project_deleted', ?
     FROM custom_domain
     WHERE projectId = ? AND cfCustomHostnameId IS NOT NULL`,
  ).bind(Math.floor(Date.now() / 1000), projectId);
}

// --- Queue lookup ---

/**
 * Look up the queue CF resource ID for a project. Used by the queue
 * send endpoint in deployments/routes.ts.
 */
export async function getProjectQueueId(env: Env, projectId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT r.cfResourceId
     FROM project_resource_binding b
     JOIN resource r ON b.resourceId = r.id
     WHERE b.projectId = ? AND r.cfResourceType = 'queue' AND r.status = 'active'`,
  )
    .bind(projectId)
    .first<{ cfResourceId: string }>();
  return row?.cfResourceId ?? null;
}
