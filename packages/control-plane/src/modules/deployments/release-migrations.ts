import { cfApi } from "@solcreek/deploy-core";
import type { Env } from "../../types.js";

/**
 * Release-phase migrations: with `[release] migrations = true`, a production
 * deploy applies the project's pending migrations after its resources are
 * provisioned and before the new worker goes live (solcreek/creek#57). A
 * first deploy works too, since its database was just provisioned.
 *
 * Applied state lives in the same `_creek_migrations` table, keyed by the
 * same migration names, as `creek db migrate`, so the two can be mixed and a
 * migration is never applied twice.
 */

/** A migration as the CLI ships it in the bundle (same shape the sandbox uses). */
export interface BundleMigration {
  name: string;
  statements: string[];
}

const TRACKING_TABLE_SQL = `CREATE TABLE IF NOT EXISTS _creek_migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);`;

/**
 * Each migration goes to D1 as one /query request, statements and tracking
 * insert together, which D1 runs as one batch. A migration over this size is
 * refused rather than split: split across requests, a failure part-way would
 * leave its earlier statements applied while it stays pending, and the next
 * deploy would replay them.
 */
export const MAX_MIGRATION_BYTES = 90 * 1024;

type ResolvedBinding = { bindingName: string; cfResourceId: string; cfType: string };

/**
 * The database migrations apply to: the one bound as DATABASE (what
 * `[resources] database` binds), else DB (its deprecated alias, and the
 * usual wrangler name), else the project's only D1. With several D1s and
 * none of those names there is no safe choice, so the deploy is refused
 * rather than guessing.
 */
export function pickMigrationDatabase(
  resolved: Map<string, ResolvedBinding>,
): { ok: true; bindingName: string; databaseId: string } | { ok: false; message: string } {
  const d1s = [...resolved.values()].filter((b) => b.cfType === "d1");
  const chosen =
    d1s.find((b) => b.bindingName === "DATABASE") ??
    d1s.find((b) => b.bindingName === "DB") ??
    (d1s.length === 1 ? d1s[0] : null);
  if (chosen) return { ok: true, bindingName: chosen.bindingName, databaseId: chosen.cfResourceId };
  return {
    ok: false,
    message:
      d1s.length === 0
        ? "[release] migrations is on but the project has no database. Declare one with [resources] database = true."
        : `[release] migrations is on but the project has ${d1s.length} databases and none is bound as DATABASE or DB, so there is no single database to migrate.`,
  };
}

async function d1Query(
  env: Env,
  databaseId: string,
  sql: string,
): Promise<Array<{ results?: Array<Record<string, unknown>> }>> {
  return cfApi(
    env,
    "POST",
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}/query`,
    {
      sql,
    },
  );
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function appliedNames(env: Env, databaseId: string): Promise<Set<string>> {
  const rows = await d1Query(env, databaseId, "SELECT name FROM _creek_migrations ORDER BY name;");
  return new Set((rows?.[0]?.results ?? []).map((r) => String(r.name)));
}

/**
 * Apply the migrations the database hasn't recorded, in bundle order. Each
 * migration is one request, its statements followed by its tracking insert,
 * so it is recorded exactly when its statements ran. Throws on the first
 * failure, naming the migration; nothing after it runs.
 *
 * Two production deploys of one project can race here. The loser's request
 * fails (its DDL finds the tables, or its tracking insert hits the primary
 * key), so a failure is checked against the tracking table: if the
 * migration is now recorded, another deploy applied it and this one moves on.
 */
export async function applyReleaseMigrations(
  env: Env,
  databaseId: string,
  migrations: BundleMigration[],
  log: (message: string) => void,
): Promise<{ applied: string[]; alreadyApplied: number }> {
  await d1Query(env, databaseId, TRACKING_TABLE_SQL);
  const done = await appliedNames(env, databaseId);
  const alreadyApplied = migrations.filter((m) => done.has(m.name)).length;

  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.name) || migration.statements.length === 0) continue;
    const track = `INSERT INTO _creek_migrations (name, applied_at) VALUES ('${escapeSqlLiteral(migration.name)}', ${Date.now()});`;
    const sql = [...migration.statements, track].join("\n");
    const bytes = new TextEncoder().encode(sql).byteLength;
    if (bytes > MAX_MIGRATION_BYTES) {
      throw new Error(
        `migration ${migration.name} is ${Math.ceil(bytes / 1024)} KB; a release migration must fit in ${MAX_MIGRATION_BYTES / 1024} KB so it applies as one batch. Split it into smaller migration files.`,
      );
    }
    try {
      await d1Query(env, databaseId, sql);
    } catch (err) {
      if (
        (await appliedNames(env, databaseId).catch(() => new Set<string>())).has(migration.name)
      ) {
        log(`Migration ${migration.name} was applied by a concurrent deploy`);
        continue;
      }
      throw new Error(
        `migration ${migration.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    applied.push(migration.name);
    log(`Applied migration ${migration.name} (${migration.statements.length} statements)`);
  }
  return { applied, alreadyApplied };
}
