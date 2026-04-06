# Realtime Todos

[![Deploy to Creek](https://creek.dev/button.svg)](https://creek.dev/new?repo=https://github.com/solcreek/creek&path=examples/realtime-todos)

A full-stack todo app with **real-time multi-user sync** — built with [Creek](https://creek.dev) in under 100 lines of code.

Open the app in two browser tabs (or share the link with a friend) and watch changes appear instantly on both screens. No polling, no manual WebSocket code, no infrastructure setup.

## What This Demonstrates

- **`db.mutate()`** — Write to the database. Changes automatically broadcast to all connected clients.
- **`useLiveQuery()`** — Fetch data and auto-refetch when the database changes. Supports optimistic updates with auto-rollback.
- **`<LiveRoom>`** — Session-scoped realtime rooms. Each room gets its own data and WebSocket channel.
- **`mutate()` with request descriptors** — `{ method: "POST", path: "/api/todos", body: { text } }` handles JSON, headers, and room context automatically.
- **`onChange` callback** — Get notified when data changes for animations and derived state.
- **Query deduplication** — Multiple components sharing the same query path make one fetch, not many.
- **Geo-personalized seed data** — Each visitor sees their edge location and country flag.

## The Code

### Server — `worker/index.ts`

```typescript
import { Hono } from "hono";
import { db } from "creek";
import { room } from "creek/hono";

const app = new Hono();
app.use("/api/*", room());

app.get("/api/todos", async (c) => {
  const todos = await db.query(
    "SELECT * FROM todos WHERE room_id = ? ORDER BY created_at DESC",
    c.var.room,
  );
  return c.json(todos);
});

app.post("/api/todos", async (c) => {
  const { text } = await c.req.json();
  await db.mutate(
    "INSERT INTO todos (id, room_id, text) VALUES (?, ?, ?)",
    crypto.randomUUID().slice(0, 16), c.var.room, text,
  );
  return c.json({ ok: true });
});
```

`db.mutate()` does two things: executes the SQL **and** broadcasts a change notification to all clients in the same room. The developer doesn't write any WebSocket code.

### Client — `src/App.tsx`

```tsx
import { LiveRoom, useLiveQuery } from "creek/react";

function App() {
  return (
    <LiveRoom id={roomId}>
      <TodoApp />
    </LiveRoom>
  );
}

function TodoApp() {
  const { data: todos, mutate } = useLiveQuery<Todo[]>("/api/todos", {
    initialData: [],
  });

  const addTodo = (text: string) =>
    mutate(
      { method: "POST", path: "/api/todos", body: { text } },
      (prev) => [{ text, completed: 0 }, ...prev],
    );
}
```

`useLiveQuery` fetches data on mount and subscribes to real-time updates via WebSocket. `mutate()` accepts a request descriptor — handles JSON serialization, room headers, and Content-Type automatically. The second argument is an optimistic updater — the UI updates instantly, rolls back on failure, then reconciles with the server.

### Configuration — `creek.toml`

```toml
[project]
name = "realtime-todos"

[build]
worker = "worker/index.ts"

[resources]
d1 = true
```

Three lines. Creek auto-bundles the Worker entry, provisions the database, configures the realtime service, and deploys to 300+ edge locations. No `build-worker.js`, no `wrangler.toml`.

## Quick Start

### Deploy to Creek

```bash
# From this directory
npx creek deploy

# Or deploy directly from GitHub
npx creek deploy https://github.com/solcreek/creek --path examples/realtime-todos
```

### Fork and Deploy

```bash
git clone https://github.com/YOUR_USERNAME/creek.git
cd creek/examples/realtime-todos
npm install
npx creek deploy
```

### Local Development

```bash
npm install
npm run dev
```

### Run Tests

```bash
npm test
```

## How It Works

```
Browser A                    Creek                         Browser B
────────                    ─────                         ────────

  POST /api/todos ──────►  worker receives request
  { text: "Buy milk" }     │
                            ├─ db.mutate() writes to D1
                            │
                            ├─ Creek runtime auto-broadcasts
                            │  to the realtime service
                            │
                            ├─ Durable Object sends          ◄── WebSocket
                            │  { type: "db_changed" }            connected
                            │                                     │
                            │                                     ▼
  optimistic update         │                              useLiveQuery ───►
  already applied           │                              auto-refetches
```

1. **Browser A** adds a todo via `mutate({ method: "POST", ... })`
2. **Optimistic update** shows the todo immediately in Browser A
3. **`db.mutate()`** writes to D1 and broadcasts to the realtime service
4. **Browser B** receives the WebSocket message and auto-refetches
5. Stale refetches from rapid operations are automatically discarded

## Room Isolation

Each visitor gets a unique room ID in the URL (`?room=a1b2c3d4`). Rooms are fully isolated:

- **Data**: SQL queries filter by `room_id` — each room only sees its own todos
- **Realtime**: WebSocket broadcasts are scoped to the room
- **Sharing**: Copy the URL to invite others into the same room

## Project Structure

```
realtime-todos/
├── creek.toml              # Creek configuration (3 lines)
├── index.html              # SPA entry point + styles
├── worker/
│   └── index.ts            # Hono API server (~80 lines)
├── src/
│   ├── App.tsx             # React app with LiveRoom + split view
│   ├── components/
│   │   ├── TodoList.tsx    # Todo list with toggle/delete
│   │   ├── TodoInput.tsx   # Add todo form
│   │   ├── StatusBar.tsx   # Connection status + peer count
│   │   ├── ShareButton.tsx # Copy shareable URL
│   │   └── DatabaseView.tsx# Live database table with row flash
│   └── hooks/
│       └── useRoomId.ts    # Read/generate room from URL
├── migrations/
│   └── 0001_todos.sql      # D1 schema
└── tests/
    ├── worker.test.ts      # API route tests
    └── useRoomId.test.ts   # Hook tests
```

## Creek API Reference

This app uses 6 Creek APIs — that's the entire surface area:

| API | Side | Purpose |
|-----|------|---------|
| `db.query(sql, ...params)` | Server | Read from database, returns typed rows |
| `db.mutate(sql, ...params)` | Server | Write to database, auto-broadcasts to room |
| `room()` | Server | Hono middleware, reads room from request header |
| `<LiveRoom id={...}>` | Client | React provider, manages shared WebSocket + query cache |
| `useLiveQuery(path, opts?)` | Client | Returns `{ data, mutate, isLoading, isConnected }` |
| `useRoom()` | Client | Returns `{ roomId, isConnected, peers }` |

## ORM Compatibility

`db` implements the full D1Database interface. Use it with Prisma or Drizzle — broadcasts still work:

```ts
import { db } from "creek";
import { drizzle } from "drizzle-orm/d1";

const orm = drizzle(db);
await orm.insert(todos).values({ roomId, text });
// Drizzle calls db.prepare().run() internally → Creek auto-broadcasts
```

## What Creek Abstracts Away

Building this same app directly on Cloudflare requires understanding and configuring:

| Concept | What you'd need to do | Creek equivalent |
|---------|----------------------|-----------------|
| D1 Database | Create binding, configure wrangler.toml | `d1 = true` in creek.toml |
| Durable Objects | Write DO class, handle WebSocket pairs, Hibernation API | Automatic |
| WebSocket protocol | Manage connections, reconnection, heartbeats | `<LiveRoom>` |
| Broadcast routing | POST to DO stub, route by room ID | `db.mutate()` does it |
| Client-side sync | Build custom hooks, manage WS lifecycle | `useLiveQuery()` |
| Deployment config | wrangler.toml, bindings, migrations, secrets | `creek.toml` (3 lines) |

**~60 lines with Creek vs ~200 lines with raw Cloudflare.**

## License

Apache-2.0
