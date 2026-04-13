# creek

[![npm](https://img.shields.io/npm/v/creek)](https://www.npmjs.com/package/creek)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue)](https://github.com/solcreek/creek)

Deploy full-stack apps to the edge. Database, realtime sync, and AI — all built in.

## Install

```bash
npx creek deploy
```

Or install globally:

```bash
npm install -g creek
```

## Deploy

```bash
creek deploy                        # Auto-detect framework, build, deploy
creek deploy --template landing     # Clone + build + deploy a Vite + React starter
creek deploy ./dist                 # Deploy a pre-built directory
creek dev                           # Local development server
```

## Server Runtime

```ts
import { db, kv, storage, ai } from "creek";

// Database — managed D1, no config needed
const users = await db.query("SELECT * FROM users");
await db.mutate("INSERT INTO users (id, name) VALUES (?, ?)", id, name);

// Define tables — auto-created on first request (powered by d1-schema)
db.define({
  users: {
    id: "text primary key",
    email: "text unique not null",
    name: "text not null",
  },
});
```

### Schema with d1-schema

Use [`d1-schema`](https://www.npmjs.com/package/d1-schema) for declarative table definitions:

```bash
npm install d1-schema
```

```ts
import { define } from "d1-schema";

await define(env.DB, {
  todos: {
    id: "text primary key",
    text: "text not null",
    completed: "integer default 0",
    _indexes: ["completed"],
  },
});
```

Tables auto-created on first use. No migration files, no CLI commands.

## Realtime

```ts
import { LiveRoom, useLiveQuery, usePresence } from "creek/react";

function App() {
  return (
    <LiveRoom id={roomId}>
      <TodoApp />
    </LiveRoom>
  );
}

function TodoApp() {
  const { data: todos, mutate } = useLiveQuery("/api/todos", {
    initialData: [],
  });

  const addTodo = (text) =>
    mutate(
      { method: "POST", path: "/api/todos", body: { text } },
      (prev) => [{ text, completed: 0 }, ...prev],
    );
}
```

## Hono Middleware

```ts
import { room } from "creek/hono";

app.use("/api/*", room());
// c.var.room is now available — broadcasts scoped to this room
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `creek deploy` | Deploy to production |
| `creek dev` | Local development server |
| `creek logs` | Read recent logs (`--follow` for live tail) |
| `creek rollback` | Rollback to previous deployment |
| `creek domains` | Manage custom domains |
| `creek env` | Manage environment variables |
| `creek login` | Authenticate |
| `creek init` | Initialize a new project |

## Links

- [Documentation](https://creek.dev/docs)
- [GitHub](https://github.com/solcreek/creek)
- [d1-schema](https://www.npmjs.com/package/d1-schema) — Declarative D1 schema management

## License

Apache-2.0
