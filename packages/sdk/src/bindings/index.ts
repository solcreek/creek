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

/**
 * The resource type each aliased primary name stands for: only a D1 named
 * DATABASE gets DB, and only a KV namespace named CACHE gets KV. Workers AI
 * or an R2 bucket a user named DATABASE gets no alias. Keyed by config type
 * (`creek dev`); ALIASED_BINDING_TYPES is the same in Worker binding types.
 */
export const DEPRECATED_ALIAS_TYPES: Record<string, "d1" | "kv" | undefined> = {
  DATABASE: "d1",
  CACHE: "kv",
};

const WORKER_BINDING_TYPE = { d1: "d1", kv: "kv_namespace" } as const;

const ALIASED_BINDING_TYPES: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(DEPRECATED_ALIAS_TYPES).map(([name, type]) => [
    name,
    type && WORKER_BINDING_TYPE[type],
  ]),
);

/**
 * The deprecated-alias bindings to add for a list of Worker bindings: for
 * each binding with a primary name that has an alias (DATABASE → DB), a copy
 * under the alias pointing at the same resource. An alias name already taken
 * in the list is skipped, so a binding the user named explicitly always wins
 * and no Worker env name is bound twice. Only the primary's own resource type
 * is aliased: Workers AI or an R2 bucket a user named DATABASE gets no DB.
 *
 * Production and sandbox deploys both use this, so a preview binds the same
 * names as the production deploy it previews (solcreek/creek#61).
 */
export function deprecatedAliasBindings<T extends { name: string; type: string }>(
  bindings: readonly T[],
): T[] {
  const taken = new Set(bindings.map((b) => b.name));
  const aliases: T[] = [];
  for (const binding of bindings) {
    const alias = DEPRECATED_BINDING_ALIASES[binding.name];
    if (!alias || taken.has(alias)) continue;
    if (binding.type !== ALIASED_BINDING_TYPES[binding.name]) continue;
    aliases.push({ ...binding, name: alias });
    taken.add(alias);
  }
  return aliases;
}

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
