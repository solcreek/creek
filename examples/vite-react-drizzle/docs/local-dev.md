# Local development

```bash
pnpm install
pnpm dev
```

That starts two processes via `concurrently`:

- **vite** on `:5173` — serves `src/*`, proxies `/api/*` to the API
- **api** on `:3000` — `tsx watch server/local.ts`, talking to `./local.db`

Open <http://localhost:5173>.

## The local DB

`./local.db` is a SQLite file managed by `better-sqlite3`. It's gitignored.
Schema is created on boot by `ensureSchema()` in `server/local.ts` so a
fresh checkout works without a separate migration step.

Want to inspect it?

```bash
sqlite3 local.db ".schema"
sqlite3 local.db "SELECT * FROM todos"
```

Want to nuke it and start fresh?

```bash
rm local.db
pnpm dev
```

## Schema changes

Edit `server/schema.ts`, then:

```bash
pnpm db:generate              # drizzle-kit emits SQL to drizzle/migrations
```

Locally, the simplest path is to delete `local.db` and let
`ensureSchema()` recreate it. For production-style migration runs against
`local.db`, write a small `tsx` script that reads the migration files and
applies them via `drizzle-orm/better-sqlite3/migrator`. (Skipped here to
keep the example small.)

## Why two processes?

Vite and the API run separately so the API can use Node-only modules
(`better-sqlite3` is a native binding) without dragging them into the
browser bundle. Vite's dev `server.proxy` (see `vite.config.ts`) forwards
`/api/*` to `:3000`, so the frontend always calls relative URLs and you
don't need CORS.

In production, Vite isn't running — Cloudflare serves the built `dist/`
assets, and the same `/api/*` paths hit the Worker entry instead.
