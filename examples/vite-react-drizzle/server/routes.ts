/**
 * Hono routes — shared between the local Node entry and the Cloudflare
 * Worker entry. The only thing that differs between runtimes is the
 * Drizzle driver (better-sqlite3 vs D1), so routes take a `resolveDb`
 * factory rather than a bound db. Local entry passes a singleton;
 * Worker entry builds one per request from `c.env.DB`.
 *
 * Keep this file free of any Node-only or Workers-only API. If you
 * need `process.env` or `caches.default`, do it in the entry file
 * and pass the value in.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { todos, type Todo } from "./schema.js";

export type Db = BaseSQLiteDatabase<"async" | "sync", unknown, Record<string, never>>;

export function createApi<Env = unknown>(resolveDb: (env: Env) => Db) {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/api/todos", async (c) => {
    const db = resolveDb(c.env);
    const rows = (await db.select().from(todos)) as Todo[];
    return c.json(rows);
  });

  app.post("/api/todos", async (c) => {
    const body = (await c.req.json()) as { title?: unknown };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return c.json({ error: "title required" }, 400);
    const db = resolveDb(c.env);
    const [row] = (await db.insert(todos).values({ title }).returning()) as Todo[];
    return c.json(row, 201);
  });

  app.patch("/api/todos/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
    const body = (await c.req.json()) as { done?: unknown };
    if (typeof body.done !== "boolean") {
      return c.json({ error: "done must be boolean" }, 400);
    }
    const db = resolveDb(c.env);
    const [row] = (await db
      .update(todos)
      .set({ done: body.done })
      .where(eq(todos.id, id))
      .returning()) as Todo[];
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  app.delete("/api/todos/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
    const db = resolveDb(c.env);
    await db.delete(todos).where(eq(todos.id, id));
    return c.json({ ok: true });
  });

  return app;
}
