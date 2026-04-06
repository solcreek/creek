import type { Env } from "../../types.js";
import {
  BINDING_NAMES,
  INTERNAL_VARS,
  PROVISIONABLE_RESOURCES,
  type ProvisionableResource,
  type ResourceRequirements,
} from "@solcreek/sdk";
import {
  createD1Database,
  createR2Bucket,
  createKVNamespace,
  getD1Database,
  getR2Bucket,
  getKVNamespace,
} from "./cloudflare.js";

// --- Types ---

export interface ProjectResource {
  projectId: string;
  resourceType: ProvisionableResource;
  cfResourceId: string;
  cfResourceName: string;
  status: string;
}

export interface WfPBinding {
  type: string;
  name: string;
  [key: string]: unknown;
}

// --- Resource name generation ---

function resourceName(projectId: string): string {
  // Use first 8 chars of UUID — 4B+ combinations, collision-safe
  return `creek-${projectId.slice(0, 8)}`;
}

// --- Provisioning ---

/**
 * Ensure all required resources exist for a project.
 * Idempotent: existing resources are not recreated.
 * Failed resources are retried on next deploy.
 */
export async function ensureResources(
  env: Env,
  projectId: string,
  requirements: ResourceRequirements,
): Promise<ProjectResource[]> {
  // Fetch existing resources for this project
  const existing = await env.DB.prepare(
    "SELECT projectId, resourceType, cfResourceId, cfResourceName, status FROM project_resource WHERE projectId = ?",
  )
    .bind(projectId)
    .all<ProjectResource>();

  const existingMap = new Map(
    existing.results.map((r) => [r.resourceType, r]),
  );

  const results: ProjectResource[] = [];

  for (const type of PROVISIONABLE_RESOURCES) {
    if (!requirements[type]) continue;

    const current = existingMap.get(type);

    // Already active — skip
    if (current?.status === "active") {
      results.push(current);
      continue;
    }

    // Provision (or retry if previous attempt failed)
    const name = resourceName(projectId);
    const resource = await provisionResource(env, projectId, type, name, current);
    results.push(resource);
  }

  return results;
}

async function provisionResource(
  env: Env,
  projectId: string,
  type: ProvisionableResource,
  name: string,
  existing: ProjectResource | undefined,
): Promise<ProjectResource> {
  // If no record exists, insert as provisioning
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO project_resource (projectId, resourceType, cfResourceId, cfResourceName, status, createdAt)
       VALUES (?, ?, '', ?, 'provisioning', ?)`,
    )
      .bind(projectId, type, name, Date.now())
      .run();
  }

  try {
    // Try to adopt existing CF resource first (handles retry after partial failure)
    let cfResourceId = await findExistingCFResource(env, type, name);

    if (!cfResourceId) {
      cfResourceId = await createCFResource(env, type, name);
    }

    // Mark active
    await env.DB.prepare(
      `UPDATE project_resource SET cfResourceId = ?, status = 'active' WHERE projectId = ? AND resourceType = ?`,
    )
      .bind(cfResourceId, projectId, type)
      .run();

    return {
      projectId,
      resourceType: type,
      cfResourceId,
      cfResourceName: name,
      status: "active",
    };
  } catch (err) {
    // Mark failed — will retry on next deploy
    await env.DB.prepare(
      `UPDATE project_resource SET status = 'failed' WHERE projectId = ? AND resourceType = ?`,
    )
      .bind(projectId, type)
      .run();

    throw new Error(
      `Failed to provision ${type} for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function findExistingCFResource(
  env: Env,
  type: ProvisionableResource,
  name: string,
): Promise<string | null> {
  switch (type) {
    case "d1":
      return getD1Database(env, name);
    case "r2":
      return (await getR2Bucket(env, name)) ? name : null;
    case "kv":
      return getKVNamespace(env, name);
    default:
      return null;
  }
}

async function createCFResource(
  env: Env,
  type: ProvisionableResource,
  name: string,
): Promise<string> {
  switch (type) {
    case "d1":
      return createD1Database(env, name);
    case "r2":
      await createR2Bucket(env, name);
      return name; // R2 bucket ID = its name
    case "kv":
      return createKVNamespace(env, name);
    default:
      throw new Error(`Unknown resource type: ${type}`);
  }
}

// --- Binding assembly ---

/**
 * Build WfP bindings array from project resources.
 * Asserts all resources belong to the specified project.
 */
export function buildBindings(
  resources: ProjectResource[],
  projectId: string,
  envVars: { key: string; value: string }[],
  options: {
    projectSlug: string;
    realtimeUrl: string;
    realtimeSecret?: string;
    needsAi: boolean;
    /** Override canonical binding names (e.g., wrangler declares binding = "MY_DB" instead of "DB") */
    bindingNameOverrides?: Map<string, string>;
  },
): WfPBinding[] {
  const bindings: WfPBinding[] = [];
  const nameFor = (type: string) =>
    options.bindingNameOverrides?.get(type) ?? BINDING_NAMES[type as keyof typeof BINDING_NAMES];

  for (const resource of resources) {
    // Critical safety assertion
    if (resource.projectId !== projectId) {
      throw new Error(
        `Binding safety violation: resource ${resource.resourceType} (${resource.cfResourceId}) belongs to project ${resource.projectId}, not ${projectId}`,
      );
    }

    if (resource.status !== "active") {
      throw new Error(
        `Cannot bind ${resource.resourceType}: status is '${resource.status}', expected 'active'`,
      );
    }

    switch (resource.resourceType) {
      case "d1":
        bindings.push({
          type: "d1",
          name: nameFor("d1"),
          id: resource.cfResourceId,
        });
        break;
      case "r2":
        bindings.push({
          type: "r2_bucket",
          name: nameFor("r2"),
          bucket_name: resource.cfResourceName,
        });
        break;
      case "kv":
        bindings.push({
          type: "kv_namespace",
          name: nameFor("kv"),
          namespace_id: resource.cfResourceId,
        });
        break;
    }
  }

  // AI binding (account-level, no per-tenant resource)
  if (options.needsAi) {
    bindings.push({ type: "ai", name: nameFor("ai") });
  }

  // Internal vars
  bindings.push({
    type: "plain_text",
    name: INTERNAL_VARS.projectSlug,
    text: options.projectSlug,
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
 * Copy active resources into resource_cleanup_queue before the project is deleted.
 * project_resources has ON DELETE CASCADE, so it will be wiped when the project row
 * is removed — the cleanup queue is the durable record that drives async deletion
 * of the actual Cloudflare resources (D1 databases, R2 buckets, KV namespaces).
 */
export async function scheduleResourceDeletion(
  env: Env,
  projectId: string,
): Promise<void> {
  // Snapshot active resources into the cleanup queue
  await env.DB.prepare(
    `INSERT INTO resource_cleanup_queue (resourceType, cfResourceId, cfResourceName, status, reason)
     SELECT resourceType, cfResourceId, cfResourceName, 'pending', 'project_deleted'
     FROM project_resource
     WHERE projectId = ? AND status IN ('active', 'provisioning')`,
  )
    .bind(projectId)
    .run();

  // Also queue custom domain hostnames for CF cleanup
  await env.DB.prepare(
    `INSERT INTO resource_cleanup_queue (resourceType, cfResourceId, cfResourceName, status, reason)
     SELECT 'custom_hostname', cfCustomHostnameId, hostname, 'pending', 'project_deleted'
     FROM custom_domain
     WHERE projectId = ? AND cfCustomHostnameId IS NOT NULL`,
  )
    .bind(projectId)
    .run();
}
