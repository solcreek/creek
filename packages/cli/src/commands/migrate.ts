/**
 * Migration logic for `creek db migrate`.
 *
 * Pure functions are exported for testing. The CLI command wires
 * them together with the SDK client in db.ts. Discovery and parsing live in
 * the sdk so remote builds ship the same migrations as `creek deploy`.
 */

export {
  MIGRATION_DIRS,
  collectMigrations,
  detectMigrationDir,
  parseMigrationFiles,
  splitMigrationStatements as splitStatements,
  type MigrationBundle,
  type MigrationFile,
} from "@solcreek/sdk";
import type { MigrationFile } from "@solcreek/sdk";

// --- Batch statements for fewer round-trips ---

/**
 * Control-plane's /resources/:id/query rejects a `sql` payload over 100KB.
 * Stay well under it so JSON/transport overhead can't push a batch over.
 */
export const MAX_BATCH_BYTES = 90_000;

/**
 * Group ordered SQL statements into as few batches as possible, each a single
 * multi-statement string under `maxBytes`. CF D1's /query executes a
 * multi-statement string in one call (SQLite's own tokenizer splits it, so
 * triggers/strings with inner semicolons are safe), which collapses the
 * per-statement HTTP round-trips `creek db migrate` used to make — the cost
 * that made migrating a many-table schema feel slow — down to ~one per file.
 *
 * Order is preserved: statements are packed greedily, never reordered. A
 * single statement larger than `maxBytes` becomes its own (oversize) batch
 * rather than being dropped — the server-side limit then surfaces the real
 * problem instead of us silently truncating.
 */
export function batchStatements(
  statements: string[],
  maxBytes: number = MAX_BATCH_BYTES,
): string[] {
  const batches: string[] = [];
  let current = "";
  for (const stmt of statements) {
    const piece = stmt.trim();
    if (!piece) continue;
    if (current === "") {
      current = piece;
      continue;
    }
    // +1 for the joining newline.
    if (Buffer.byteLength(current) + 1 + Buffer.byteLength(piece) > maxBytes) {
      batches.push(current);
      current = piece;
    } else {
      current = `${current}\n${piece}`;
    }
  }
  if (current !== "") batches.push(current);
  return batches;
}

// --- Compute pending migrations ---

/**
 * Given files on disk and names already applied, return the pending
 * migrations in order.
 */
export function computePending(files: MigrationFile[], applied: Set<string>): MigrationFile[] {
  return files.filter((f) => !applied.has(f.name));
}
