/**
 * Local KVNamespace adapter backed by SQLite.
 *
 * Uses a single table with lazy TTL expiration. Accepts a bun:sqlite
 * Database instance so it can share the same DB file as the D1 adapter.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER
  )
`;

const CREATE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv_store(expires_at)
    WHERE expires_at IS NOT NULL
`;

export class LocalKVNamespace {
  private db: Database;

  constructor(dbOrPath: Database | string) {
    if (typeof dbOrPath === "string") {
      mkdirSync(dirname(dbOrPath), { recursive: true });
      this.db = new Database(dbOrPath);
      this.db.exec("PRAGMA journal_mode = WAL");
    } else {
      this.db = dbOrPath;
    }
    this.db.exec(CREATE_TABLE);
    this.db.exec(CREATE_INDEX);
  }

  async get(key: string, _options?: { type?: string }): Promise<string | null> {
    const row = this.db
      .query("SELECT value, expires_at FROM kv_store WHERE key = ?")
      .get(key) as { value: string; expires_at: number | null } | null;

    if (!row) return null;
    if (row.expires_at !== null && Date.now() >= row.expires_at) {
      this.db.run("DELETE FROM kv_store WHERE key = ?", key);
      return null;
    }
    return row.value;
  }

  async getWithMetadata<T = unknown>(key: string): Promise<{ value: string | null; metadata: T | null }> {
    const value = await this.get(key);
    return { value, metadata: null };
  }

  async put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void> {
    const expiresAt = options?.expirationTtl != null
      ? Date.now() + options.expirationTtl * 1000
      : null;
    this.db.run(
      "INSERT OR REPLACE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)",
      key, value, expiresAt,
    );
  }

  async delete(key: string): Promise<void> {
    this.db.run("DELETE FROM kv_store WHERE key = ?", key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; expiration?: number }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const now = Date.now();

    // Lazy cleanup: purge expired entries on list
    this.db.run("DELETE FROM kv_store WHERE expires_at IS NOT NULL AND expires_at < ?", now + 1);

    const rows = this.db
      .query(
        "SELECT key, expires_at FROM kv_store WHERE key LIKE ? ORDER BY key LIMIT ?",
      )
      .all(prefix + "%", limit + 1) as Array<{ key: string; expires_at: number | null }>;

    const truncated = rows.length > limit;
    const keys = rows.slice(0, limit).map((r) => ({
      name: r.key,
      ...(r.expires_at ? { expiration: Math.floor(r.expires_at / 1000) } : {}),
    }));

    return { keys, list_complete: !truncated };
  }
}
