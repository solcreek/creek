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

/** Stay under D1 /query request limits, as `creek db migrate` does. */
const MAX_BATCH_BYTES = 90 * 1024;

type ResolvedBinding = { bindingName: string; cfResourceId: string; cfType: string };

/**
 * The database migrations apply to: the one bound as DB (or its deprecated
 * alias DATABASE), else the project's only D1 — the same choice the sandbox
 * makes when it seeds a preview database. With several D1s and none named DB
 * there is no safe choice, so the deploy is refused rather than guessing.
 */
export function pickMigrationDatabase(
  resolved: Map<string, ResolvedBinding>,
): { ok: true; bindingName: string; databaseId: string } | { ok: false; message: string } {
  const d1s = [...resolved.values()].filter((b) => b.cfType === "d1");
  const chosen =
    d1s.find((b) => b.bindingName === "DB") ??
    d1s.find((b) => b.bindingName === "DATABASE") ??
    (d1s.length === 1 ? d1s[0] : null);
  if (chosen) return { ok: true, bindingName: chosen.bindingName, databaseId: chosen.cfResourceId };
  return {
    ok: false,
    message:
      d1s.length === 0
        ? "[release] migrations is on but the project has no database. Declare one with [resources] database = true."
        : `[release] migrations is on but the project has ${d1s.length} databases and none is bound as DB, so there is no single database to migrate.`,
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

/** Group statements into requests under MAX_BATCH_BYTES, in order. */
function batch(statements: string[]): string[] {
  const batches: string[] = [];
  let current = "";
  for (const statement of statements) {
    const next = current ? `${current}\n${statement}` : statement;
    if (current && new TextEncoder().encode(next).byteLength > MAX_BATCH_BYTES) {
      batches.push(current);
      current = statement;
    } else {
      current = next;
    }
  }
  if (current) batches.push(current);
  return batches;
}

/**
 * Apply the migrations the database hasn't recorded, in bundle order. Each
 * migration's statements travel with its tracking insert, so a migration is
 * recorded exactly when its statements ran (as `creek db migrate` does).
 * Throws on the first failure, naming the migration; nothing after it runs.
 */
export async function applyReleaseMigrations(
  env: Env,
  databaseId: string,
  migrations: BundleMigration[],
  log: (message: string) => void,
): Promise<{ applied: string[]; alreadyApplied: number }> {
  await d1Query(env, databaseId, TRACKING_TABLE_SQL);
  const rows = await d1Query(env, databaseId, "SELECT name FROM _creek_migrations ORDER BY name;");
  const done = new Set((rows?.[0]?.results ?? []).map((r) => String(r.name)));

  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.name) || migration.statements.length === 0) continue;
    const track = `INSERT INTO _creek_migrations (name, applied_at) VALUES ('${escapeSqlLiteral(migration.name)}', ${Date.now()});`;
    try {
      for (const sql of batch([...migration.statements, track])) {
        await d1Query(env, databaseId, sql);
      }
    } catch (err) {
      throw new Error(
        `migration ${migration.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    applied.push(migration.name);
    log(`Applied migration ${migration.name} (${migration.statements.length} statements)`);
  }
  return { applied, alreadyApplied: migrations.filter((m) => done.has(m.name)).length };
}
