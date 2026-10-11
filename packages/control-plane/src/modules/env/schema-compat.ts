import type { D1Database } from "@cloudflare/workers-types";

/**
 * Whether environment_variable has the `target` column (migration 0013).
 *
 * Migrations are applied by hand and the Worker deploys on merge, so this
 * code can run against the table before 0013 is applied. Every reader and
 * writer checks first and falls back to the old single-value-per-key shape,
 * so deploying first and migrating after is safe: deploys keep working and
 * per-target requests are refused (env_targets_unavailable) until 0013 runs.
 *
 * A yes is cached per database: the migration only goes one way. A no is
 * not, so the switch happens on the first request after 0013 is applied.
 */
const available = new WeakMap<object, true>();

export async function envTargetsAvailable(db: D1Database): Promise<boolean> {
  if (available.has(db)) return true;
  try {
    await db.prepare("SELECT target FROM environment_variable LIMIT 0").all();
  } catch (err) {
    // Only a missing column means "before 0013". Any other failure (a
    // transient D1 error) must not select the fallback: after 0013 it would
    // relabel production- and preview-only values as all-deploys values.
    if (/no such column/i.test(err instanceof Error ? err.message : String(err))) return false;
    throw err;
  }
  available.set(db, true);
  return true;
}

export const ENV_TARGETS_UNAVAILABLE = {
  error: "env_targets_unavailable",
  message:
    "Per-target environment variables are not available on this server yet (database migration 0013 has not been applied). Only all-deploys values can be set or removed.",
} as const;
