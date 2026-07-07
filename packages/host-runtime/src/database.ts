import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database as SqliteDatabase } from "bun:sqlite";

export type DatabaseResult<T = Record<string, unknown>> = {
  results: T[];
  success: true;
  meta: {
    duration: number;
    last_row_id: number;
    changes: number;
    served_by: string;
  };
};

class CreekPreparedStatement {
  constructor(
    private db: SqliteDatabase,
    private sql: string,
    private params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): CreekPreparedStatement {
    return new CreekPreparedStatement(this.db, this.sql, values);
  }

  async all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>> {
    const start = performance.now();
    const stmt = this.db.query(this.sql);
    const results = stmt.all(...(this.params as never[])) as T[];
    return {
      results,
      success: true,
      meta: {
        duration: performance.now() - start,
        last_row_id: 0,
        changes: 0,
        served_by: "creek-host-database",
      },
    };
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.query(this.sql);
    const row = stmt.get(...(this.params as never[])) as Record<string, unknown> | null;
    if (!row) return null;
    if (colName) return (row[colName] ?? null) as T | null;
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<DatabaseResult<T>> {
    const start = performance.now();
    const stmt = this.db.prepare(this.sql);
    const result = stmt.run(...(this.params as never[]));
    return {
      results: [],
      success: true,
      meta: {
        duration: performance.now() - start,
        last_row_id: Number(result.lastInsertRowid ?? 0),
        changes: result.changes,
        served_by: "creek-host-database",
      },
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const stmt = this.db.query(this.sql);
    return stmt.values(...(this.params as never[])) as T[];
  }
}

export class CreekDatabase {
  constructor(private db: SqliteDatabase) {}

  prepare(query: string): CreekPreparedStatement {
    return new CreekPreparedStatement(this.db, query);
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    const start = performance.now();
    this.db.exec(query);
    return { count: 0, duration: performance.now() - start };
  }
}

export function openDatabase(path: string): CreekDatabase {
  const parent = dirname(path);
  if (parent && parent !== ".") {
    mkdirSync(parent, { recursive: true });
  }
  const db = new SqliteDatabase(path);
  db.exec("PRAGMA journal_mode = WAL;");
  return new CreekDatabase(db);
}
