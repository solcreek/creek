# vite-react-drizzle

Vite + React + Hono + Drizzle todo app. **Same business logic runs locally
against `better-sqlite3` and on Cloudflare Workers against D1**, with no
runtime dependency on Creek.

```
src/                  Vite + React frontend
server/
  schema.ts           Drizzle schema (single source of truth)
  routes.ts           Hono routes (driver-agnostic)
  local.ts            Node entry — better-sqlite3
  worker.ts           Workers entry — D1
drizzle.config.ts     drizzle-kit config
creek.toml            Creek deploy config
```

## Quick start

```bash
pnpm install
pnpm dev          # vite (5173) + api (3000)
```

Open <http://localhost:5173>, add a todo, refresh — it's persisted in
`./local.db`.

To deploy: see [docs/deploy-creek.md](docs/deploy-creek.md). To run on
Cloudflare without Creek: see [docs/migrate-away.md](docs/migrate-away.md).

## Why this shape

The app is split into three layers so the runtime difference is contained:

| Layer | File | Cares about runtime? |
|-------|------|----------------------|
| Frontend | `src/*` | No |
| Schema | `server/schema.ts` | No |
| API routes | `server/routes.ts` | No (takes a db factory) |
| Local entry | `server/local.ts` | Yes — uses `better-sqlite3` |
| Worker entry | `server/worker.ts` | Yes — uses `env.DB` (D1) |

The two entry files are ~30 lines each. Everything else is portable.

## Docs

- [docs/local-dev.md](docs/local-dev.md) — running locally, schema migrations
- [docs/deploy-creek.md](docs/deploy-creek.md) — `creek deploy` walkthrough
- [docs/migrate-away.md](docs/migrate-away.md) — moving off Creek to plain wrangler
