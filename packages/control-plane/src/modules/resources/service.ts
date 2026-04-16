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
 *   4. Returns `WfPBinding[]` ready for the Workers for Platforms API
 */

import type { Env } from "../../types.js";
import {
  BINDING_NAMES,
  INTERNAL_VARS,
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

/** Binding requirement from the CLI bundle */
export interface BundleBindingRequirement {
  type: "d1" | "r2" | "kv" | "ai";
  bindingName: string;
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
};

// --- Core: ensure bindings for deploy ---

/**
 * Ensure all binding requirements are satisfied for a project deploy.
 *
 * For each requirement from the CLI bundle:
 *   - If a `project_resource_binding` already exists for that bindingName,
 *     use the linked resource (provision CF if needed)
 *   - Otherwise, auto-create a resource + binding
 *
 * Returns resolved resource rows keyed by binding name.
 */
export async function ensureProjectBindings(
  env: Env,
  projectId: string,
  teamId: string,
  requirements: BundleBindingRequirement[],
): Promise<Map<string, { bindingName: string; cfResourceId: string; cfType: string }>> {
  if (requirements.length === 0) return new Map();

  // Fetch existing bindings for this project
  const existingRows = await env.DB.prepare(
    `SELECT b.bindingName, b.resourceId, r.kind, r.cfResourceId, r.cfResourceType
     FROM project_resource_binding b
     JOIN resource r ON b.resourceId = r.id
     WHERE b.projectId = ?`,
  )
    .bind(projectId)
    .all<ResolvedBinding>();

  const existingByName = new Map(
    existingRows.results.map((b) => [b.bindingName, b]),
  );

  const result = new Map<string, { bindingName: string; cfResourceId: string; cfType: string }>();

  for (const req of requirements) {
    const existing = existingByName.get(req.bindingName);

    if (existing && existing.cfResourceId) {
      // Binding exists with a provisioned CF resource — use it
      result.set(req.bindingName, {
        bindingName: req.bindingName,
        cfResourceId: existing.cfResourceId,
        cfType: existing.cfResourceType ?? req.type,
      });
      continue;
    }

    if (existing && !existing.cfResourceId) {
      // Binding exists but CF resource not yet provisioned — provision now
      const cfName = `creek-${existing.resourceId.slice(0, 8)}`;
      const cfType = KIND_TO_CF[existing.kind] ?? req.type;
      const cfId = await findExistingCFResource(env, cfType, cfName)
        ?? await provisionCFResource(env, cfType, cfName);

      await env.DB.prepare(
        `UPDATE resource SET cfResourceId = ?, cfResourceType = ?, status = 'active', updatedAt = ?
         WHERE id = ?`,
      )
        .bind(cfId, cfType, Date.now(), existing.resourceId)
        .run();

      result.set(req.bindingName, {
        bindingName: req.bindingName,
        cfResourceId: cfId,
        cfType,
      });
      continue;
    }

    // No binding exists — auto-create resource + binding
    const resourceId = crypto.randomUUID();
    const cfName = `creek-${resourceId.slice(0, 8)}`;
    const kind = CF_TO_KIND[req.type] ?? req.type;
    const cfType = req.type;
    const now = Date.now();

    // Provision CF resource
    let cfId: string | null = null;
    if (cfType === "d1" || cfType === "r2" || cfType === "kv") {
      cfId = await findExistingCFResource(env, cfType, cfName)
        ?? await provisionCFResource(env, cfType, cfName);
    }

    // Insert resource row
    await env.DB.prepare(
      `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
      .bind(resourceId, teamId, kind, cfName, cfId, cfType, now, now)
      .run();

    // Insert binding
    await env.DB.prepare(
      `INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(projectId, req.bindingName, resourceId, now)
      .run();

    if (cfId) {
      result.set(req.bindingName, {
        bindingName: req.bindingName,
        cfResourceId: cfId,
        cfType,
      });
    }
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
): Promise<{ cfResourceId: string; cfResourceName: string }> {
  // Check for existing queue binding
  const existing = await env.DB.prepare(
    `SELECT b.resourceId, r.cfResourceId, r.cfResourceType
     FROM project_resource_binding b
     JOIN resource r ON b.resourceId = r.id
     WHERE b.projectId = ? AND b.bindingName = ?`,
  )
    .bind(projectId, BINDING_NAMES.queue)
    .first<{ resourceId: string; cfResourceId: string | null; cfResourceType: string | null }>();

  if (existing?.cfResourceId) {
    const name = `creek-q-${existing.resourceId.slice(0, 8)}`;
    return { cfResourceId: existing.cfResourceId, cfResourceName: name };
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
    // Insert resource + binding
    await env.DB.prepare(
      `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
       VALUES (?, ?, 'queue', ?, ?, 'queue', 'active', ?, ?)`,
    )
      .bind(resourceId, teamId, queueName, queueId, now, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(projectId, BINDING_NAMES.queue, resourceId, now)
      .run();
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
  resolvedBindings: Map<string, { bindingName: string; cfResourceId: string; cfType: string }>,
  envVars: { key: string; value: string }[],
  options: {
    projectSlug: string;
    projectId: string;
    realtimeUrl: string;
    realtimeSecret?: string;
    needsAi: boolean;
    queueName?: string;
  },
): WfPBinding[] {
  const bindings: WfPBinding[] = [];

  for (const [, resolved] of resolvedBindings) {
    switch (resolved.cfType) {
      case "d1":
        bindings.push({
          type: "d1",
          name: resolved.bindingName,
          id: resolved.cfResourceId,
        });
        break;
      case "r2":
        bindings.push({
          type: "r2_bucket",
          name: resolved.bindingName,
          bucket_name: resolved.cfResourceId,
        });
        break;
      case "kv":
        bindings.push({
          type: "kv_namespace",
          name: resolved.bindingName,
          namespace_id: resolved.cfResourceId,
        });
        break;
    }
  }

  // Queue producer binding
  if (options.queueName) {
    bindings.push({
      type: "queue",
      name: BINDING_NAMES.queue,
      queue_name: options.queueName,
    });
  }

  // AI binding (account-level, no per-tenant resource)
  if (options.needsAi) {
    bindings.push({ type: "ai", name: BINDING_NAMES.ai });
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
 * Schedule resource deletion when a project is deleted.
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
export async function scheduleResourceCleanup(
  env: Env,
  projectId: string,
): Promise<void> {
  // Queue custom domain hostnames for CF cleanup
  await env.DB.prepare(
    `INSERT INTO resource_cleanup_queue (resourceType, cfResourceId, cfResourceName, status, reason)
     SELECT 'custom_hostname', cfCustomHostnameId, hostname, 'pending', 'project_deleted'
     FROM custom_domain
     WHERE projectId = ? AND cfCustomHostnameId IS NOT NULL`,
  )
    .bind(projectId)
    .run();
}

// --- Queue lookup ---

/**
 * Look up the queue CF resource ID for a project. Used by the queue
 * send endpoint in deployments/routes.ts.
 */
export async function getProjectQueueId(
  env: Env,
  projectId: string,
): Promise<string | null> {
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
