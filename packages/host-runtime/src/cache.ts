import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type CacheGetType = "text" | "json" | "arrayBuffer" | "stream";

export type CachePutOptions = {
  expirationTtl?: number; // seconds from now
  expiration?: number; // unix seconds
  metadata?: unknown;
};

export type CacheListOptions = {
  prefix?: string;
  limit?: number;
  cursor?: string;
};

export type CacheListEntry<Metadata = unknown> = {
  name: string;
  expiration?: number;
  metadata?: Metadata;
};

export type CacheListResult<Metadata = unknown> = {
  keys: CacheListEntry<Metadata>[];
  list_complete: boolean;
  cursor?: string;
};

type Row = {
  value: Uint8Array;
  metadata: string | null;
  expiration_ms: number | null;
};

class CreekCache {
  constructor(private db: Database) {}

  async get(
    key: string,
    type: CacheGetType = "text",
  ): Promise<string | object | ArrayBuffer | ReadableStream | null> {
    const row = this.db
      .query(`SELECT value, metadata, expiration_ms FROM cache WHERE key = ?`)
      .get(key) as Row | null;
    if (!row) return null;
    if (row.expiration_ms !== null && row.expiration_ms < Date.now()) {
      this.db.prepare(`DELETE FROM cache WHERE key = ?`).run(key);
      return null;
    }
    return decodeValue(row.value, type);
  }

  async getWithMetadata<M = unknown>(
    key: string,
    type: CacheGetType = "text",
  ): Promise<{
    value: string | object | ArrayBuffer | ReadableStream | null;
    metadata: M | null;
  }> {
    const row = this.db
      .query(`SELECT value, metadata, expiration_ms FROM cache WHERE key = ?`)
      .get(key) as Row | null;
    if (!row) return { value: null, metadata: null };
    if (row.expiration_ms !== null && row.expiration_ms < Date.now()) {
      this.db.prepare(`DELETE FROM cache WHERE key = ?`).run(key);
      return { value: null, metadata: null };
    }
    const value = decodeValue(row.value, type);
    const metadata = row.metadata ? (JSON.parse(row.metadata) as M) : null;
    return { value, metadata };
  }

  async put(
    key: string,
    value: string | ReadableStream | ArrayBuffer | Uint8Array,
    options?: CachePutOptions,
  ): Promise<void> {
    const buf = await encodeValue(value);

    let expirationMs: number | null = null;
    if (options?.expiration !== undefined) {
      expirationMs = options.expiration * 1000;
    } else if (options?.expirationTtl !== undefined) {
      expirationMs = Date.now() + options.expirationTtl * 1000;
    }

    const metadataStr = options?.metadata !== undefined ? JSON.stringify(options.metadata) : null;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO cache (key, value, metadata, expiration_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run(key, buf, metadataStr, expirationMs);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare(`DELETE FROM cache WHERE key = ?`).run(key);
  }

  async list<M = unknown>(options: CacheListOptions = {}): Promise<CacheListResult<M>> {
    const limit = options.limit ?? 1000;
    const prefix = options.prefix ?? "";
    const cursor = options.cursor ?? "";
    const now = Date.now();

    const rows = this.db
      .query(
        `SELECT key, metadata, expiration_ms FROM cache
         WHERE key LIKE ? || '%' AND key > ?
           AND (expiration_ms IS NULL OR expiration_ms > ?)
         ORDER BY key
         LIMIT ?`,
      )
      .all(prefix, cursor, now, limit + 1) as Array<{
      key: string;
      metadata: string | null;
      expiration_ms: number | null;
    }>;

    const overflow = rows.length > limit;
    const trimmed = rows.slice(0, limit);
    const keys: CacheListEntry<M>[] = trimmed.map((r) => {
      const entry: CacheListEntry<M> = { name: r.key };
      if (r.expiration_ms !== null) {
        entry.expiration = Math.floor(r.expiration_ms / 1000);
      }
      if (r.metadata) {
        entry.metadata = JSON.parse(r.metadata) as M;
      }
      return entry;
    });

    const cursorNext =
      overflow && trimmed.length > 0 ? trimmed[trimmed.length - 1]!.key : undefined;
    return {
      keys,
      list_complete: !overflow,
      cursor: cursorNext,
    };
  }
}

function decodeValue(
  buf: Uint8Array,
  type: CacheGetType,
): string | object | ArrayBuffer | ReadableStream {
  if (type === "arrayBuffer") {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  if (type === "stream") {
    return new Response(buf as BodyInit).body!;
  }
  const text = new TextDecoder().decode(buf);
  if (type === "json") return JSON.parse(text);
  return text;
}

async function encodeValue(
  value: string | ReadableStream | ArrayBuffer | Uint8Array,
): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof ReadableStream) {
    const reader = value.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk as Uint8Array);
      total += (chunk as Uint8Array).byteLength;
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    return merged;
  }
  throw new Error(`cache put: unsupported value type`);
}

export function openCache(path: string): CreekCache {
  const parent = dirname(path);
  if (parent && parent !== ".") mkdirSync(parent, { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key           TEXT PRIMARY KEY,
      value         BLOB NOT NULL,
      metadata      TEXT,
      expiration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cache_expiration
      ON cache (expiration_ms) WHERE expiration_ms IS NOT NULL;
  `);
  return new CreekCache(db);
}

export type { CreekCache };
