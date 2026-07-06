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
  /**
   * How many of the bound databases were actually readable. Status is
   * evaluated over these — an unreadable DB is skipped and could, in
   * principle, be more up-to-date than the one reported.
   */
  databasesEvaluated: number;
  /**
   * Readable bound databases that lag the evaluated one, with their pending
   * count. Non-empty means the bound databases disagree on applied migrations:
   * if the app queries a laggard it 500s even when the reported DB is in sync.
   */
  laggingDatabases: Array<{ name: string; pending: number }>;
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
    databasesEvaluated: 0,
    laggingDatabases: [],
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

  // Read every bound database's applied state. Unreadable ones are skipped;
  // if none are readable we degrade to "unknown".
  const evaluated: Array<{ name: string; applied: Set<string>; pending: string[] }> = [];
  for (const db of dbs) {
    const appliedSet = await readAppliedSet(opts.client, db.resourceId);
    if (!appliedSet) continue;
    evaluated.push({
      name: db.name,
      applied: appliedSet,
      pending: computePending(files, appliedSet).map((f) => f.name),
    });
  }
  if (evaluated.length === 0) return { ...base, status: "unknown" };
  base.databasesEvaluated = evaluated.length;

  // Report against the most up-to-date database — fewest pending migrations,
  // breaking ties toward more applied.
  let best = evaluated[0];
  for (const e of evaluated.slice(1)) {
    if (
      e.pending.length < best.pending.length ||
      (e.pending.length === best.pending.length && e.applied.size > best.applied.size)
    ) {
      best = e;
    }
  }

  // A readable database that has applied SOME migrations but fewer than the
  // leader is genuinely in use and lagging — if the app queries it, it 500s
  // even when the reported database is in sync. We require applied > 0 so a
  // pristine empty/never-migrated D1 (an idle spare — the B10 case) doesn't
  // resurrect the phantom "pending" warning this whole check set out to kill.
  // The empty spare and a lagging live DB are otherwise indistinguishable
  // here; "has been migrated at all" is the best signal we have to tell them
  // apart without knowing which DB the app queries at runtime.
  const laggingDatabases = evaluated
    .filter((e) => e !== best && e.applied.size > 0 && e.pending.length > best.pending.length)
    .map((e) => ({ name: e.name, pending: e.pending.length }));

  return {
    ...base,
    status: best.pending.length > 0 ? "pending" : "in-sync",
    pending: best.pending,
    applied: best.applied.size,
    databaseName: best.name,
    laggingDatabases,
  };
}

/**
 * Describe which database the status is about when several are bound, without
 * overclaiming: status is only evaluated over the *readable* databases, so an
 * unreadable one (skipped) could in principle be more up-to-date.
 */
function scopeSuffix(drift: MigrationDrift): string {
  const { databaseCount, databasesEvaluated } = drift;
  if (databaseCount <= 1) return "";
  if (databasesEvaluated <= 1) {
    // The others couldn't be read — don't claim "most up-to-date of N".
    return ` (${databasesEvaluated} of ${databaseCount} bound databases was readable)`;
  }
  if (databasesEvaluated < databaseCount) {
    return ` (most up-to-date of ${databasesEvaluated} readable of ${databaseCount} bound databases)`;
  }
  return ` (most up-to-date of ${databaseCount} bound databases)`;
}

/** "database \"x\" is 2 behind" / "databases \"x\" (2 behind), \"y\" (5 behind) lag". */
function laggardClause(lagging: MigrationDrift["laggingDatabases"]): string {
  if (lagging.length === 1) {
    const l = lagging[0];
    return `bound database "${l.name}" is ${l.pending} migration${l.pending === 1 ? "" : "s"} behind`;
  }
  const names = lagging.map((l) => `"${l.name}" (${l.pending} behind)`).join(", ");
  return `bound databases ${names} lag the schema`;
}

/**
 * A one-line, actionable warning for a drift result — or null when there's
 * nothing worth saying (in sync with no lagging peer, no migrations). The
 * deploy command prints this after a successful deploy so a lagging schema
 * doesn't go unnoticed.
 */
export function driftWarning(drift: MigrationDrift): string | null {
  const lagging = drift.laggingDatabases;
  switch (drift.status) {
    case "pending": {
      const db = drift.databaseName ?? "<db>";
      const n = drift.pending.length;
      let msg = `${n} migration${n === 1 ? "" : "s"} not yet applied to database "${db}"${scopeSuffix(drift)}. Deploy does not apply migrations — run \`creek db migrate ${db}\` or your DB lags the code (e.g. D1_ERROR: no such column).`;
      // Other bound DBs even further behind are worth naming too.
      if (lagging.length > 0) {
        msg += ` Also, ${laggardClause(lagging)} — run \`creek db migrate\` on ${lagging.length === 1 ? "it" : "each"}.`;
      }
      return msg;
    }
    case "in-sync":
      // The most up-to-date DB is current, but a bound peer lags it — if the
      // app queries that peer it 500s. This is the signal a single-DB check
      // (or picking the most-migrated DB and staying silent) would miss.
      if (lagging.length > 0) {
        const db = drift.databaseName ?? "<db>";
        return `Database "${db}" is up to date, but ${laggardClause(lagging)}. Deploy does not apply migrations — if your app queries a lagging database it will 500 (D1_ERROR: no such column); run \`creek db migrate\` on ${lagging.length === 1 ? "it" : "each"}.`;
      }
      return null;
    case "no-database":
      return `Local migrations found but no database is bound to this project. Run \`creek db attach\` and \`creek db migrate\` so the schema matches your code.`;
    case "unknown":
    case "no-migrations":
      return null;
  }
}
