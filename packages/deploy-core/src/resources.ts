/**
 * Cloudflare resource provisioning (D1 / R2 / KV) via the REST API.
 *
 * Shared between control-plane (full production tenants) and
 * sandbox-api (ephemeral 60-minute previews). Both need the same
 * create/get/delete primitives; centralising them here avoids
 * duplication and keeps naming conventions consistent.
 *
 * All functions take the full `DeployEnv`-compatible env so the same
 * `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` plumbing reused
 * from `deploy.ts` works without a second secrets setup.
 */

import { cfApi } from "./cf-api.js";
import type { DeployEnv } from "./types.js";

// --- D1 ---

/**
 * Create a new D1 database. Returns the provisioned UUID.
 * Name must be 1-64 chars, alphanumeric + hyphens.
 */
export async function createD1Database(
  env: DeployEnv,
  name: string,
): Promise<string> {
  const result = await cfApi(
    env,
    "POST",
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database`,
    { name },
  );
  return (result as { uuid: string }).uuid;
}

/**
 * Look up a D1 database by name. Returns the UUID or null if absent.
 * Used for idempotent provisioning (retry safety).
 */
export async function getD1DatabaseByName(
  env: DeployEnv,
  name: string,
): Promise<string | null> {
  try {
    const result = await cfApi(
      env,
      "GET",
      `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database?name=${encodeURIComponent(name)}`,
    );
    const dbs = Array.isArray(result) ? (result as Array<{ name: string; uuid: string }>) : [];
    const match = dbs.find((db) => db.name === name);
    return match?.uuid ?? null;
  } catch {
    return null;
  }
}

export async function deleteD1Database(
  env: DeployEnv,
  databaseId: string,
): Promise<void> {
  await cfApi(
    env,
    "DELETE",
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}`,
  );
}

// --- R2 ---

/**
 * Create an R2 bucket. R2 bucket names are globally unique within the
 * account, 3-63 chars, lowercase alphanumeric + hyphens.
 */
export async function createR2Bucket(
  env: DeployEnv,
  name: string,
  locationHint: string = "apac",
): Promise<void> {
  await cfApi(env, "POST", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets`, {
    name,
    locationHint,
  });
}

export async function r2BucketExists(
  env: DeployEnv,
  name: string,
): Promise<boolean> {
  try {
    await cfApi(env, "GET", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${name}`);
    return true;
  } catch {
    return false;
  }
}

export async function deleteR2Bucket(
  env: DeployEnv,
  name: string,
): Promise<void> {
  await cfApi(env, "DELETE", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${name}`);
}

// --- KV ---

/**
 * Create a Workers KV namespace. Returns the namespace ID.
 */
export async function createKVNamespace(
  env: DeployEnv,
  title: string,
): Promise<string> {
  const result = await cfApi(
    env,
    "POST",
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces`,
    { title },
  );
  return (result as { id: string }).id;
}

export async function getKVNamespaceByTitle(
  env: DeployEnv,
  title: string,
): Promise<string | null> {
  try {
    const result = await cfApi(
      env,
      "GET",
      `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces?per_page=100`,
    );
    const namespaces = Array.isArray(result)
      ? (result as Array<{ id: string; title: string }>)
      : [];
    const match = namespaces.find((ns) => ns.title === title);
    return match?.id ?? null;
  } catch {
    return null;
  }
}

export async function deleteKVNamespace(
  env: DeployEnv,
  namespaceId: string,
): Promise<void> {
  await cfApi(
    env,
    "DELETE",
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}`,
  );
}
