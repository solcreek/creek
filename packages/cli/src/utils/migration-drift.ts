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
  /** Name of the bound database, when one was found. */
  databaseName: string | null;
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

/**
 * Compare the project's local migration files against the applied state of the
 * database bound to the project. Best-effort: any unexpected failure resolves
 * to `status: "unknown"` rather than throwing, so it can never break a deploy.
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
  };
  if (!migrationDir) return base;

  const files = parseMigrationFiles(migrationDir);
  if (files.length === 0) return base;
  base.total = files.length;

  // Which database does this project deploy against?
  let db: { resourceId: string; name: string } | undefined;
  try {
    const { bindings } = await opts.client.listBindings(opts.projectSlug);
    db = bindings.find((b) => b.kind === "database");
  } catch {
    return { ...base, status: "unknown" };
  }
  if (!db) return { ...base, status: "no-database" };
  base.databaseName = db.name;

  // Read applied migrations. A missing tracking table means nothing has been
  // applied yet (every local migration is pending); any other failure is
  // "unknown" so we degrade quietly instead of crying wolf.
  let appliedSet: Set<string>;
  try {
    const result = await opts.client.queryDatabase(
      db.resourceId,
      "SELECT name FROM _creek_migrations ORDER BY name;",
    );
    appliedSet = new Set((result.rows as { name: string }[]).map((r) => r.name));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (MISSING_TABLE.test(msg)) {
      appliedSet = new Set();
    } else {
      return { ...base, status: "unknown" };
    }
  }

  const pending = computePending(files, appliedSet).map((f) => f.name);
  return {
    ...base,
    status: pending.length > 0 ? "pending" : "in-sync",
    pending,
    applied: appliedSet.size,
    databaseName: db.name,
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
      return `${n} migration${n === 1 ? "" : "s"} not yet applied to database "${db}". Deploy does not apply migrations — run \`creek db migrate ${db}\` or your DB lags the code (e.g. D1_ERROR: no such column).`;
    }
    case "no-database":
      return `Local migrations found but no database is bound to this project. Run \`creek db attach\` and \`creek db migrate\` so the schema matches your code.`;
    case "unknown":
    case "in-sync":
    case "no-migrations":
      return null;
  }
}
