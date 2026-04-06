// creek runtime — server-side
//
// Usage:
//   import { db, kv, storage, ai } from 'creek';
//
// `db` writes automatically notify the realtime service.
// With room() middleware, broadcasts are scoped to the active room.

import { AsyncLocalStorage } from "node:async_hooks";

// ─── Request Context (AsyncLocalStorage) ──────────────────────────────────────
// Per-request isolation for env and ctx. Prevents race conditions when
// multiple requests are in-flight concurrently in the same Worker isolate.

interface RequestContext {
  env: Record<string, unknown>;
  ctx: { waitUntil(promise: Promise<unknown>): void } | null;
}

const requestStore = new AsyncLocalStorage<RequestContext>();

/**
 * Run a handler within an isolated request context.
 * All creek runtime reads (db, kv, notifyRealtime, etc.) use this context.
 * @internal — called by auto-generated worker wrapper
 */
export function _runRequest<T>(
  env: Record<string, unknown>,
  ctx: { waitUntil(promise: Promise<unknown>): void } | null,
  fn: () => T,
): T {
  return requestStore.run({ env, ctx }, fn);
}

// ─── Fallback globals (deprecated) ────────────────────────────────────────────
// Kept for backward compatibility. AsyncLocalStorage context takes precedence.

let _envFallback: Record<string, unknown> | null = null;
let _ctxFallback: { waitUntil(promise: Promise<unknown>): void } | null = null;

/**
 * @internal @deprecated — use _runRequest() instead.
 * Sets module-level env as fallback when not inside _runRequest().
 */
export function _setEnv(env: Record<string, unknown>): void {
  _envFallback = env;
}

/**
 * @internal @deprecated — use _runRequest() instead.
 * Sets module-level ctx as fallback when not inside _runRequest().
 */
export function _setCtx(
  ctx: { waitUntil(promise: Promise<unknown>): void } | null,
): void {
  _ctxFallback = ctx;
}

function getEnv(): Record<string, unknown> | null {
  return requestStore.getStore()?.env ?? _envFallback;
}

function getCtx(): { waitUntil(promise: Promise<unknown>): void } | null {
  return requestStore.getStore()?.ctx ?? _ctxFallback;
}

// ─── Room Context ─────────────────────────────────────────────────────────────
// Separate AsyncLocalStorage because room is set by middleware, not at
// request entry. Nests inside the request context.

const roomStore = new AsyncLocalStorage<string | null>();

/** @internal — used by room() middleware via roomStore.run() */
export const _roomStore = roomStore;

/**
 * @internal @deprecated — use _roomStore.run() instead.
 * Kept for backward compatibility with manual _setRoom() calls.
 */
let _roomIdFallback: string | null = null;
export function _setRoom(roomId: string | null): void {
  _roomIdFallback = roomId;
}

function getRoomId(): string | null {
  return roomStore.getStore() ?? _roomIdFallback;
}

// ─── Realtime notification ──────────────────────────────────────────────────

export function notifyRealtime(table: string, operation: string): void {
  const env = getEnv();
  const realtimeUrl = env?.CREEK_REALTIME_URL as string | undefined;
  const realtimeSecret = env?.CREEK_REALTIME_SECRET as string | undefined;
  const slug = env?.CREEK_PROJECT_SLUG as string | undefined;

  if (!realtimeUrl || !slug) return; // Realtime not configured — silent no-op

  const roomId = getRoomId();

  // Room-scoped or project-wide broadcast
  const broadcastPath = roomId
    ? `${realtimeUrl}/${slug}/rooms/${roomId}/broadcast`
    : `${realtimeUrl}/${slug}/broadcast`;

  try {
    const broadcastPromise = fetch(broadcastPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(realtimeSecret
          ? { Authorization: `Bearer ${realtimeSecret}` }
          : {}),
      },
      body: JSON.stringify({ table, operation }),
    });

    // Register with execution context for guaranteed delivery
    const ctx = getCtx();
    if (ctx) {
      ctx.waitUntil(broadcastPromise.catch(() => {}));
    } else {
      // Fallback: fire-and-forget without waitUntil
      broadcastPromise.catch(() => {});
    }
  } catch {
    // Construction error (unlikely) — ignore
  }
}

// ─── DB Proxy (D1 with auto-realtime) ───────────────────────────────────────

function extractTable(sql: string): string {
  const match = sql.match(
    /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+["'`]?(\w+)/i,
  );
  return match?.[1] ?? "unknown";
}

function wrapStatement(
  stmt: D1PreparedStatement,
  sql: string,
): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, prop) {
      const val = (target as any)[prop];

      // .bind() returns a new statement — re-wrap it to keep the notification hook
      if (prop === "bind") {
        return (...args: unknown[]) => {
          const bound = (val as Function).apply(target, args);
          return wrapStatement(bound, sql);
        };
      }

      // .run() is semantically for writes (D1 API design).
      // Always broadcast — no regex needed. ORM-generated SQL works correctly.
      if (prop === "run") {
        return async (...args: unknown[]) => {
          const result = await (val as Function).apply(target, args);
          const table = extractTable(sql);
          const op = sql.trimStart().split(/\s/)[0].toUpperCase();
          notifyRealtime(table, op);
          return result;
        };
      }

      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}

function createDbProxy(): CreekDatabase {
  return new Proxy({} as CreekDatabase, {
    get(_, prop) {
      const env = getEnv();
      if (!env) return typeof prop === "symbol" ? undefined : () => {};
      const binding = env.DB as D1Database | undefined;
      if (!binding) {
        throw new Error(
          "[creek] Database is not enabled. Add `database = true` to [resources] in creek.toml",
        );
      }

      if (prop === "prepare") {
        return (sql: string) => wrapStatement(binding.prepare(sql), sql);
      }

      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          const result = await binding.batch(stmts);
          // Notify once for batch — signals all live queries should refetch
          notifyRealtime("*", "BATCH");
          return result;
        };
      }

      // ─── Convenience API: db.define(schema) ───
      if (prop === "define") {
        return async (schema: import("d1-schema").SchemaDefinition, options?: import("d1-schema").DefineOptions) => {
          const { define: d1Define } = await import("d1-schema");
          return d1Define(binding, schema, options);
        };
      }

      // ─── Convenience API: db.query<T>(sql, ...params) ───
      if (prop === "query") {
        return async <T>(sql: string, ...params: unknown[]): Promise<T[]> => {
          const stmt =
            params.length > 0
              ? binding.prepare(sql).bind(...params)
              : binding.prepare(sql);
          const result = await stmt.all();
          return result.results as T[];
        };
      }

      // ─── Convenience API: db.mutate(sql, ...params) ───
      if (prop === "mutate") {
        return async (sql: string, ...params: unknown[]) => {
          // Go through wrapStatement so broadcast fires
          const wrapped = wrapStatement(binding.prepare(sql), sql);
          const stmt =
            params.length > 0 ? wrapped.bind(...params) : wrapped;
          const result = await stmt.run();
          return {
            changes: result.meta.changes,
            lastRowId: result.meta.last_row_id,
          };
        };
      }

      const val = (binding as any)[prop];
      return typeof val === "function" ? val.bind(binding) : val;
    },
  });
}

// ─── Simple binding proxies ─────────────────────────────────────────────────

function createBinding<T extends object>(
  bindingName: string,
  label: string,
): T {
  return new Proxy({} as T, {
    get(_, prop) {
      const env = getEnv();
      if (!env) return typeof prop === "symbol" ? undefined : () => {};
      const binding = env[bindingName];
      if (!binding) {
        throw new Error(
          `[creek] ${label} is not enabled. Add \`${bindingName.toLowerCase()} = true\` to [resources] in creek.toml`,
        );
      }
      const value = (binding as Record<string | symbol, unknown>)[prop];
      return typeof value === "function"
        ? (value as Function).bind(binding)
        : value;
    },
  });
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CreekDatabase extends D1Database {
  /**
   * Declare your database schema. Tables are auto-created or altered on first use.
   * Powered by d1-schema — no migration files, no CLI.
   *
   * @example
   * ```ts
   * db.define({
   *   todos: {
   *     id: "text primary key",
   *     text: "text not null",
   *     completed: "integer default 0",
   *   },
   * });
   * ```
   */
  define(
    schema: Record<string, Record<string, string>>,
    options?: { autoMigrate?: "apply" | "warn" | "off" },
  ): Promise<void>;

  /** Execute a read query, returning typed rows directly. */
  query<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]>;

  /** Execute a write operation. Auto-broadcasts to the active room. */
  mutate(
    sql: string,
    ...params: unknown[]
  ): Promise<{ changes: number; lastRowId: number }>;
}

// ─── WebSocket Token ───────────────────────────────────────────────────────

/**
 * Generate a short-lived token for WebSocket authentication.
 * Format: {timestamp}.{hmac}
 * Valid for 5 minutes. Uses CREEK_REALTIME_SECRET as HMAC key.
 * @internal — called by auto-generated /__creek/config endpoint
 */
export async function generateWsToken(): Promise<string | null> {
  const env = getEnv();
  const secret = env?.CREEK_REALTIME_SECRET as string | undefined;
  const slug = env?.CREEK_PROJECT_SLUG as string | undefined;
  if (!secret || !slug) return null;

  const timestamp = Math.floor(Date.now() / 1000);
  const message = `${slug}:ws:${timestamp}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );

  const hmac = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${timestamp}.${hmac}`;
}

// ─── Exports ────────────────────────────────────────────────────────────────

/** D1 Database with auto-realtime on writes */
export const db: CreekDatabase = createDbProxy();

/** KV Namespace */
export const kv: KVNamespace = createBinding("KV", "KV Storage");

/** R2 Bucket */
export const storage: R2Bucket = createBinding("STORAGE", "Object Storage (R2)");

/** Workers AI */
export const ai: Ai = createBinding("AI", "AI");

/** Re-export column helpers from d1-schema for convenience */
export { column } from "d1-schema";
