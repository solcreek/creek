import { detectMigrationDir, parseMigrationFiles, computePending } from "../commands/migrate.js";

/**
 * Whether the database's schema is in sync with the project's local migration
 * files. `creek deploy` ships code but does NOT apply migrations, so a deploy
 * can succeed while the live database is missing columns/tables — surfacing as
 * a runtime 500 (`D1_ERROR: no such column`). This check lets deploy warn about
 * that gap instead of letting it fail silently in production.
 */
export type DriftStatus =
  | "in-sync" // every local migration is applied
  | "pending" // local migrations exist that the database hasn't applied
  | "no-migrations" // no migration directory / no .sql files
  | "no-database" // a migration dir exists but no database is bound to the project
  | "unknown"; // couldn't read applied state (best-effort; never blocks deploy)

export interface MigrationDrift {
  status: DriftStatus;
  migrationDir: string | null;
  /** Names of local migrations not yet applied (only meaningful for "pending"). */
  pending: string[];
  /** Count of migrations the database reports as applied. */
  applied: number;
  /** Count of local migration files. */
  total: number;
  /**
   * Name of the database the drift was evaluated against. When more than one
   * D1 is bound, this is the most up-to-date one (see {@link detectMigrationDrift}).
   */
  databaseName: string | null;
  /** How many databases are bound to the project. */
  databaseCount: number;
}

/** The slice of CreekClient this check needs — narrowed so tests can fake it. */
export interface DriftClient {
  listBindings(projectSlug: string): Promise<{
    bindings: Array<{ resourceId: string; kind: string; name: string }>;
  }>;
  queryDatabase(
    resourceId: string,
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

const MISSING_TABLE = /no such table/i;

/** Read the applied-migration names for one database. Null = unreadable. */
async function readAppliedSet(
  client: DriftClient,
  resourceId: string,
): Promise<Set<string> | null> {
  try {
    const result = await client.queryDatabase(
      resourceId,
      "SELECT name FROM _creek_migrations ORDER BY name;",
    );
    return new Set((result.rows as { name: string }[]).map((r) => r.name));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A missing tracking table means nothing has been applied yet — every
    // local migration is pending. Any other failure leaves this DB unreadable.
    return MISSING_TABLE.test(msg) ? new Set() : null;
  }
}

/**
 * Compare the project's local migration files against the applied state of the
 * database(s) bound to the project. Best-effort: any unexpected failure
 * resolves to `status: "unknown"` rather than throwing, so it can never break
 * a deploy.
 *
 * A project can bind more than one D1 (e.g. the live database plus a spare or
 * empty one). We can't know at build time which one the app queries at
 * runtime, so we evaluate every bound database and report drift against the
 * *most up-to-date* one. This keeps an empty spare from shadowing the migrated
 * database into a phantom "pending" warning that would fire on every deploy —
 * which would train users to ignore the one signal that catches a genuinely
 * lagging schema.
 */
export async function detectMigrationDrift(opts: {
  cwd: string;
  projectSlug: string;
  client: DriftClient;
  /** Override auto-detection (e.g. the `--dir` the user passed). */
  migrationDir?: string | null;
}): Promise<MigrationDrift> {
  const migrationDir = opts.migrationDir ?? detectMigrationDir(opts.cwd);
  const base: MigrationDrift = {
    status: "no-migrations",
    migrationDir,
    pending: [],
    applied: 0,
    total: 0,
    databaseName: null,
    databaseCount: 0,
  };
  if (!migrationDir) return base;

  const files = parseMigrationFiles(migrationDir);
  if (files.length === 0) return base;
  base.total = files.length;

  // Which database(s) does this project deploy against?
  let dbs: Array<{ resourceId: string; name: string }>;
  try {
    const { bindings } = await opts.client.listBindings(opts.projectSlug);
    dbs = bindings.filter((b) => b.kind === "database");
  } catch {
    return { ...base, status: "unknown" };
  }
  base.databaseCount = dbs.length;
  if (dbs.length === 0) return { ...base, status: "no-database" };

  // Evaluate each bound database, keeping the most up-to-date one — fewest
  // pending migrations, breaking ties toward more applied. Unreadable
  // databases are skipped; if every one is unreadable we degrade to "unknown".
  let best: { name: string; applied: Set<string>; pending: string[] } | null = null;
  for (const db of dbs) {
    const appliedSet = await readAppliedSet(opts.client, db.resourceId);
    if (!appliedSet) continue;
    const pending = computePending(files, appliedSet).map((f) => f.name);
    if (
      !best ||
      pending.length < best.pending.length ||
      (pending.length === best.pending.length && appliedSet.size > best.applied.size)
    ) {
      best = { name: db.name, applied: appliedSet, pending };
    }
  }

  if (!best) return { ...base, status: "unknown" };

  return {
    ...base,
    status: best.pending.length > 0 ? "pending" : "in-sync",
    pending: best.pending,
    applied: best.applied.size,
    databaseName: best.name,
  };
}

/**
 * A one-line, actionable warning for a drift result — or null when there's
 * nothing worth saying (in sync, no migrations). The deploy command prints this
 * after a successful deploy so a lagging schema doesn't go unnoticed.
 */
export function driftWarning(drift: MigrationDrift): string | null {
  switch (drift.status) {
    case "pending": {
      const db = drift.databaseName ?? "<db>";
      const n = drift.pending.length;
      // When several DBs are bound, say which one this status is about — it's
      // the most up-to-date of them, so the user knows it's not a phantom
      // count against an empty spare.
      const scope =
        drift.databaseCount > 1
          ? ` (most up-to-date of ${drift.databaseCount} bound databases)`
          : "";
      return `${n} migration${n === 1 ? "" : "s"} not yet applied to database "${db}"${scope}. Deploy does not apply migrations — run \`creek db migrate ${db}\` or your DB lags the code (e.g. D1_ERROR: no such column).`;
    }
    case "no-database":
      return `Local migrations found but no database is bound to this project. Run \`creek db attach\` and \`creek db migrate\` so the schema matches your code.`;
    case "unknown":
    case "in-sync":
    case "no-migrations":
      return null;
  }
}
