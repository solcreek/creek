/**
 * Canonical binding names used when deploying user workers via WfP.
 * The "creek" runtime package reads these same names from `env`.
 *
 * IMPORTANT: If you change a name here, update packages/runtime/src/index.ts
 * to match. The invariant test in tests/invariants/ verifies they stay in sync.
 */

/** WfP binding name → resource type mapping */
export const BINDING_NAMES = {
  d1: "DB",
  r2: "STORAGE",
  kv: "KV",
  ai: "AI",
  queue: "QUEUE",
} as const;

/** Internal env vars injected into every user worker */
export const INTERNAL_VARS = {
  projectSlug: "CREEK_PROJECT_SLUG",
  /** Stable UUID for the project — used by adapter-creek to derive
   *  per-tenant Durable Object IDs so ISR cache entries don't collide
   *  across projects sharing Creek's WfP dispatch namespace. */
  projectId: "CREEK_PROJECT_ID",
  realtimeUrl: "CREEK_REALTIME_URL",
  realtimeSecret: "CREEK_REALTIME_SECRET",
} as const;

/** Resource types that require per-tenant provisioning via CF API */
export const PROVISIONABLE_RESOURCES = ["d1", "r2", "kv"] as const;

export type ProvisionableResource = (typeof PROVISIONABLE_RESOURCES)[number];

export type ResourceRequirements = Record<ProvisionableResource, boolean> & {
  ai: boolean;
};
