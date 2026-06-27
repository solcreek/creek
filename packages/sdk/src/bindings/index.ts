/**
 * Binding names a deployed Worker sees, keyed by the underlying CF resource
 * type. The rule is uniform: the env-var name is the semantic config key,
 * uppercased (`database` → `DATABASE`, `cache` → `CACHE`, ...). Nothing is
 * translated to a CF primitive name.
 *
 * The "creek" runtime package reads these same names from `env` — keep
 * packages/runtime/src/index.ts in sync if you change a value here.
 */

/** CF resource type → env-var binding name the Worker sees */
export const BINDING_NAMES = {
  d1: "DATABASE",
  r2: "STORAGE",
  kv: "CACHE",
  ai: "AI",
  queue: "QUEUE",
} as const;

/**
 * Deprecated env-var aliases, kept bound alongside the primary name through
 * the v1.0 deprecation window so Workers that still read the old CF-primitive
 * names keep working. Maps primary name → deprecated alias. Removed at v1.0.
 *
 * (storage/ai/queue already matched the semantic key, so they have no alias.)
 */
export const DEPRECATED_BINDING_ALIASES: Record<string, string | undefined> = {
  DATABASE: "DB",
  CACHE: "KV",
};

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
