import { Hono } from "hono";
import { db } from "creek";
import { room } from "creek/hono";

const app = new Hono();

// ── Auto-migration ──

let migrated = false;

app.use("/api/*", async (c, next) => {
  if (!migrated) {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS todos (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          text TEXT NOT NULL,
          completed INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
      )
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_todos_room ON todos(room_id, created_at DESC)",
      )
      .run();
    migrated = true;
  }
  await next();
});

app.use("/api/*", room());

// ── Country code → flag emoji ──

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return "🌍";
  return String.fromCodePoint(
    ...code.toUpperCase().split("").map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

function countryName(code: string): string {
  try {
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

// ── List todos ──

app.get("/api/todos", async (c) => {
  const roomId = c.get("room") ?? "default";

  // Opportunistic cleanup: remove stale rooms (> 30 min old)
  await db
    .prepare(
      `DELETE FROM todos WHERE room_id != ? AND created_at < datetime('now', '-30 minutes')`,
    )
    .bind(roomId)
    .run();

  let todos = await db.query<{
    id: string;
    text: string;
    completed: number;
    created_at: string;
  }>(
    "SELECT id, text, completed, created_at FROM todos WHERE room_id = ? ORDER BY created_at DESC",
    roomId,
  );

  // Seed demo data for empty rooms — staggered inserts for realtime demo effect
  if (todos.length === 0) {
    const geoCountry = c.req.header("cf-ipcountry") ?? "";
    const geoCity = c.req.header("cf-ipcity") ?? "";
    const geoColo = c.req.header("cf-ipcolo") ?? "";
    const flag = countryFlag(geoCountry);
    const country = countryName(geoCountry);
    const city = geoCity || "the edge";
    const colo = geoColo || "CDN";

    const seeds = [
      { text: `Served from ${city} edge (${colo}) ${flag}`, completed: 1 },
      { text: "Share this URL — changes sync in real time", completed: 0 },
      { text: `Build something great for users in ${country}`, completed: 0 },
    ];

    // Insert first item immediately so the response isn't empty
    const first = seeds[0];
    await db.mutate(
      "INSERT INTO todos (id, room_id, text, completed) VALUES (?, ?, ?, ?)",
      crypto.randomUUID().slice(0, 16), roomId, first.text, first.completed,
    );

    // Schedule remaining inserts in background — each db.mutate() triggers
    // a REAL broadcast → REAL WebSocket event → client auto-refetches
    const remaining = seeds.slice(1);
    const ctx = c.executionCtx;
    ctx.waitUntil((async () => {
      for (const seed of remaining) {
        await new Promise((r) => setTimeout(r, 800));
        await db.mutate(
          "INSERT INTO todos (id, room_id, text, completed) VALUES (?, ?, ?, ?)",
          crypto.randomUUID().slice(0, 16), roomId, seed.text, seed.completed,
        );
      }
    })());

    todos = await db.query(
      "SELECT id, text, completed, created_at FROM todos WHERE room_id = ? ORDER BY created_at DESC",
      roomId,
    );
  }

  return c.json(todos);
});

// ── Add todo ──

app.post("/api/todos", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  const roomId = c.get("room") ?? "default";
  const id = crypto.randomUUID().slice(0, 16);

  await db.mutate(
    "INSERT INTO todos (id, room_id, text) VALUES (?, ?, ?)",
    id,
    roomId,
    text,
  );
  return c.json({ id, text, completed: 0 });
});

// ── Toggle todo ──

app.patch("/api/todos/:id", async (c) => {
  const id = c.req.param("id");
  const roomId = c.get("room") ?? "default";

  await db.mutate(
    "UPDATE todos SET completed = CASE WHEN completed = 0 THEN 1 ELSE 0 END WHERE id = ? AND room_id = ?",
    id,
    roomId,
  );
  return c.json({ ok: true });
});

// ── Delete todo ──

app.delete("/api/todos/:id", async (c) => {
  const id = c.req.param("id");
  const roomId = c.get("room") ?? "default";

  await db.mutate(
    "DELETE FROM todos WHERE id = ? AND room_id = ?",
    id,
    roomId,
  );
  return c.json({ ok: true });
});

export default app;
