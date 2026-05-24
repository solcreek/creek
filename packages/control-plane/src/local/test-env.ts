/**
 * Test environment factory using local adapters for vitest.
 *
 * Uses better-sqlite3 (works in Node/vitest) instead of bun:sqlite.
 * Replaces mock D1/R2/KV with real implementations.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Env } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../drizzle");

// --- D1 adapter (better-sqlite3 for vitest/Node) ---

class TestD1Statement {
  sql: string;
  params: unknown[];
  private db: Database.Database;

  constructor(db: Database.Database, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...args: unknown[]) {
    return new TestD1Statement(this.db, this.sql, args);
  }

  async run() {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    return {
      results: [],
      success: true,
      meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid), rows_read: 0, rows_written: info.changes },
    };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (column) return (row[column] as T) ?? null;
    return row as T;
  }

  async all<T = Record<string, unknown>>() {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.params) as T[];
    return { results: rows, success: true, meta: { changes: 0, last_row_id: 0, rows_read: rows.length, rows_written: 0 } };
  }
}

class TestD1Database {
  db: Database.Database;

  constructor(path: string = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  prepare(sql: string) { return new TestD1Statement(this.db, sql); }

  async batch(statements: TestD1Statement[]) {
    const results: any[] = [];
    const tx = this.db.transaction(() => {
      for (const stmt of statements) {
        const s = this.db.prepare(stmt.sql);
        const info = s.run(...stmt.params);
        results.push({ results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid), rows_read: 0, rows_written: info.changes } });
      }
    });
    tx();
    return results;
  }

  async exec(sql: string) { this.db.exec(sql); return { count: 1, duration: 0 }; }
  close() { this.db.close(); }
}

// --- KV adapter (better-sqlite3) ---

class TestKVNamespace {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)");
  }

  async get(key: string) {
    const row = this.db.prepare("SELECT value, expires_at FROM kv_store WHERE key = ?").get(key) as { value: string; expires_at: number | null } | undefined;
    if (!row) return null;
    if (row.expires_at !== null && Date.now() >= row.expires_at) {
      this.db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
      return null;
    }
    return row.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    const expiresAt = options?.expirationTtl != null ? Date.now() + options.expirationTtl * 1000 : null;
    this.db.prepare("INSERT OR REPLACE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)").run(key, value, expiresAt);
  }

  async delete(key: string) { this.db.prepare("DELETE FROM kv_store WHERE key = ?").run(key); }

  async list(options?: { prefix?: string; limit?: number }) {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    this.db.prepare("DELETE FROM kv_store WHERE expires_at IS NOT NULL AND expires_at <= ?").run(Date.now());
    const rows = this.db.prepare("SELECT key, expires_at FROM kv_store WHERE key LIKE ? ORDER BY key LIMIT ?").all(prefix + "%", limit + 1) as Array<{ key: string; expires_at: number | null }>;
    return {
      keys: rows.slice(0, limit).map((r) => ({ name: r.key, ...(r.expires_at ? { expiration: Math.floor(r.expires_at / 1000) } : {}) })),
      list_complete: rows.length <= limit,
    };
  }
}

// --- R2 adapter (filesystem, same as local/r2-adapter) ---

class TestR2Object {
  key: string;
  size: number;
  etag: string;
  uploaded = new Date();
  constructor(key: string, size: number) { this.key = key; this.size = size; this.etag = `"${Date.now()}"` }
}

class TestR2ObjectBody extends TestR2Object {
  private data: Buffer;
  constructor(key: string, data: Buffer) { super(key, data.length); this.data = data; }
  async arrayBuffer() { return this.data.buffer.slice(this.data.byteOffset, this.data.byteOffset + this.data.byteLength); }
  async text() { return this.data.toString("utf-8"); }
  async json<T>() { return JSON.parse(this.data.toString("utf-8")) as T; }
  get body() {
    const d = this.data;
    return new ReadableStream({ start(c) { c.enqueue(new Uint8Array(d)); c.close(); } });
  }
}

class TestR2Bucket {
  private root: string;
  constructor(root: string) { this.root = root; mkdirSync(root, { recursive: true }); }

  async get(key: string) {
    const p = join(this.root, key);
    if (!existsSync(p)) return null;
    return new TestR2ObjectBody(key, readFileSync(p));
  }

  async put(key: string, value: any) {
    const p = join(this.root, key);
    mkdirSync(dirname(p), { recursive: true });
    const buf = typeof value === "string" ? Buffer.from(value) : Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(value instanceof ArrayBuffer ? value : "");
    writeFileSync(p, buf);
    return new TestR2Object(key, buf.length);
  }

  async delete(key: string | string[]) {
    for (const k of Array.isArray(key) ? key : [key]) {
      try { unlinkSync(join(this.root, k)); } catch {}
    }
  }

  async list(options?: { prefix?: string; limit?: number }) {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const objects: TestR2Object[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (objects.length > limit) return;
        const fp = join(dir, e.name);
        if (e.isDirectory()) { walk(fp); }
        else { const k = relative(this.root, fp); if (k.startsWith(prefix)) objects.push(new TestR2Object(k, statSync(fp).size)); }
      }
    };
    walk(this.root);
    return { objects: objects.slice(0, limit), truncated: objects.length > limit, delimitedPrefixes: [] };
  }
}

// --- Factory ---

export interface LocalTestEnv {
  env: Env;
  db: TestD1Database;
  cleanup: () => void;
}

export function createLocalTestEnv(options?: { applyMigrations?: boolean }): LocalTestEnv {
  const tmpDir = mkdtempSync(join(tmpdir(), "creek-test-"));
  const db = new TestD1Database(join(tmpDir, "test.db"));
  const kvDb = new Database(join(tmpDir, "kv.db"));

  if (options?.applyMigrations !== false) {
    applyMigrations(db);
  }

  const env: Env = {
    DB: db as any,
    ASSETS: new TestR2Bucket(join(tmpDir, "assets")) as any,
    LOGS_BUCKET: new TestR2Bucket(join(tmpDir, "logs")) as any,
    BUILD_STATUS: new TestKVNamespace(kvDb) as any,
    REMOTE_BUILDER: { fetch: async () => new Response("{}") } as any,
    WEB_BUILDS: { send: async () => {} } as any,
    CREEK_DOMAIN: "bycreek.com",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    DISPATCH_NAMESPACE: "test-namespace",
    CLOUDFLARE_ZONE_ID: "test-zone-id",
    SANDBOX_API_URL: "https://sandbox-api.creek.dev",
    INTERNAL_SECRET: "test-internal-secret",
    BETTER_AUTH_SECRET: "test-secret-32-chars-minimum!!!!",
    BETTER_AUTH_URL: "http://localhost:8787",
    GITHUB_CLIENT_ID: "test-github-id",
    GITHUB_CLIENT_SECRET: "test-github-secret",
    GOOGLE_CLIENT_ID: "test-google-id",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "test-private-key",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  };

  return {
    env,
    db,
    cleanup: () => {
      db.close();
      kvDb.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

const EXTRA_TABLES = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    teamId TEXT NOT NULL,
    userId TEXT NOT NULL,
    userEmail TEXT NOT NULL,
    action TEXT NOT NULL,
    resourceType TEXT NOT NULL,
    resourceId TEXT,
    metadata TEXT,
    ipHash TEXT,
    country TEXT,
    userAgent TEXT,
    cfRay TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_user_time ON audit_log(userId, createdAt);
  CREATE INDEX IF NOT EXISTS idx_audit_log_team_time ON audit_log(teamId, createdAt);

  CREATE TABLE IF NOT EXISTS audit_ip_log (
    auditLogId TEXT NOT NULL,
    rawIp TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ip_log_created ON audit_ip_log(createdAt);
`;

function applyMigrations(db: TestD1Database) {
  if (!existsSync(MIGRATIONS_DIR)) return;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && /^\d{4}/.test(f))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    try { db.db.exec(sql); } catch {}
  }
  db.db.exec(EXTRA_TABLES);
}
