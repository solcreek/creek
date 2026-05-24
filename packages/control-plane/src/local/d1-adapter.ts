/**
 * Local D1-compatible adapter backed by bun:sqlite.
 *
 * Implements the subset of D1Database used by the control-plane:
 * - prepare(sql).bind(...args).run()
 * - prepare(sql).bind(...args).first()
 * - prepare(sql).bind(...args).all()
 * - batch([stmt1, stmt2, ...])
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes: number; last_row_id: number; rows_read: number; rows_written: number };
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

class LocalD1Statement {
  sql: string;
  params: unknown[];
  private db: Database;

  constructor(db: Database, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...args: unknown[]): LocalD1Statement {
    return new LocalD1Statement(this.db, this.sql, args);
  }

  async run(): Promise<D1Result> {
    const stmt = this.db.prepare(this.sql);
    stmt.run(...this.params);
    const changes = this.db.query("SELECT changes() as c").get() as { c: number };
    const lastId = this.db.query("SELECT last_insert_rowid() as id").get() as { id: number };
    return {
      results: [],
      success: true,
      meta: { changes: changes.c, last_row_id: lastId.id, rows_read: 0, rows_written: changes.c },
    };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params) as Record<string, unknown> | null;
    if (!row) return null;
    if (column) return (row[column] as T) ?? null;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.params) as T[];
    return {
      results: rows,
      success: true,
      meta: { changes: 0, last_row_id: 0, rows_read: rows.length, rows_written: 0 },
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const stmt = this.db.prepare(this.sql);
    return stmt.values(...this.params) as T[];
  }
}

export class LocalD1Database {
  private db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  prepare(sql: string): LocalD1Statement {
    return new LocalD1Statement(this.db, sql);
  }

  async batch(statements: LocalD1Statement[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    const transaction = this.db.transaction(() => {
      for (const stmt of statements) {
        const s = this.db.prepare(stmt.sql);
        s.run(...stmt.params);
        const changes = this.db.query("SELECT changes() as c").get() as { c: number };
        const lastId = this.db.query("SELECT last_insert_rowid() as id").get() as { id: number };
        results.push({
          results: [],
          success: true,
          meta: { changes: changes.c, last_row_id: lastId.id, rows_read: 0, rows_written: changes.c },
        });
      }
    });
    transaction();
    return results;
  }

  async exec(sql: string): Promise<D1ExecResult> {
    const start = Date.now();
    this.db.exec(sql);
    return { count: 1, duration: Date.now() - start };
  }

  close(): void {
    this.db.close();
  }

  get inner(): Database {
    return this.db;
  }
}
