/**
 * Transform a `sqlite3 DB .dump` output into D1-compatible SQL.
 *
 * Cloudflare D1 is SQLite-compatible at the core SQL level (CREATE
 * TABLE, INSERT, SELECT all "just work"), but differs from a local
 * SQLite in two ways that matter here:
 *
 *   1. D1 rejects `PRAGMA ...` statements.
 *   2. D1's batch API manages transactions itself — a manual
 *      `BEGIN TRANSACTION` / `COMMIT` collides with that.
 *
 * The other three rules below are **`.dump` format quirks**, not D1
 * limitations. `sqlite3 .dump` serialises virtual tables (FTS5) as
 * a raw `INSERT INTO sqlite_schema(...) VALUES('table', name, name, 0,
 * 'CREATE VIRTUAL TABLE ...')` bootstrap + follows up with the
 * shadow-table contents for faster restore. Neither plain SQLite nor
 * D1 can replay those verbatim — you need to unwrap the CREATE and
 * skip the shadow rows (FTS5 recreates them when the virtual table
 * is created).
 *
 * The transformation is therefore deliberately small:
 *
 *   - drop PRAGMA
 *   - drop BEGIN TRANSACTION / COMMIT
 *   - unwrap INSERT INTO sqlite_schema(...) → CREATE VIRTUAL TABLE
 *   - drop CREATE TABLE IF NOT EXISTS for FTS5 shadow tables
 *   - drop INSERT INTO for FTS5 shadow tables
 *
 * Validated against an EmDash starter dump (34 migrations + seed, 50
 * tables, 422 rows) replaying successfully against a real D1 in 21ms.
 */

/**
 * Convert a `sqlite3 .dump` text output into a D1-compatible SQL
 * string. The output is intended to be split on `;` and executed via
 * the D1 HTTP API batch endpoint.
 */
export function sqliteDumpToD1(dump: string): string {
  const statements = splitStatements(dump);
  const out: string[] = [];

  for (const stmt of statements) {
    if (/^PRAGMA /i.test(stmt)) continue;
    if (/^BEGIN TRANSACTION$/i.test(stmt)) continue;
    if (/^COMMIT$/i.test(stmt)) continue;

    // Virtual-table bootstrap: unwrap `INSERT INTO sqlite_schema(...)VALUES(...,'CREATE VIRTUAL TABLE ...')`
    // back to the CREATE VIRTUAL TABLE statement.
    const vt = stmt.match(
      /^INSERT INTO sqlite_schema\(type,name,tbl_name,rootpage,sql\)VALUES\(\s*'table'\s*,\s*'[^']+'\s*,\s*'[^']+'\s*,\s*\d+\s*,\s*'([\s\S]+)'\s*\)$/,
    );
    if (vt) {
      out.push(vt[1].replace(/''/g, "'"));
      continue;
    }

    // FTS5 shadow tables are auto-created by CREATE VIRTUAL TABLE
    // and auto-populated as content lands in the source table. Skip
    // both the shadow CREATE statements and the `.dump`-emitted
    // shadow INSERT rows. The naming convention is `<name>_data`,
    // `<name>_idx`, `<name>_docsize`, `<name>_config` for any `<name>`
    // containing `fts` (e.g. `_emdash_fts_posts_data`,
    // `fts_posts_data`).
    if (
      /^(CREATE TABLE IF NOT EXISTS|INSERT INTO)\s+['"]?\w*fts\w*_(data|idx|docsize|config)['"]?\b/i.test(stmt)
    ) {
      continue;
    }

    out.push(stmt);
  }

  return out.map((s) => s + ";").join("\n");
}

/**
 * Split a `.dump` payload on statement boundaries (`;` followed by a
 * newline). Trailing `;` on each statement is stripped so downstream
 * filters and the D1 HTTP API see bare statement bodies. Multi-line
 * payloads (e.g. CREATE VIRTUAL TABLE's embedded newlines) are
 * preserved within the statement.
 */
export function splitStatements(sql: string): string[] {
  // Strip block comments first so their internal `;` don't create
  // spurious statement boundaries. Non-greedy match across newlines.
  const withoutBlockComments = sql.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlockComments
    .split(/;\s*\n/)
    .map((s) => s.trim().replace(/;$/, "").trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}
