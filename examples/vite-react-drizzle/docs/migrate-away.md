# Moving off Creek

This app has **zero `@solcreek/*` runtime dependencies**. Everything in
`src/` and `server/` uses standard libraries:

- `hono` for the API
- `drizzle-orm/d1` for the Worker DB driver
- `drizzle-orm/better-sqlite3` for the local DB driver
- `@cloudflare/workers-types` for type hints

Moving to plain `wrangler` (your own Cloudflare account) takes three steps.

## 1. Create a `wrangler.jsonc`

```jsonc
{
  "name": "vite-react-drizzle",
  "main": "dist/_worker.mjs",
  "compatibility_date": "2026-03-14",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "vite-react-drizzle",
      "database_id": "<paste from `wrangler d1 create`>"
    }
  ]
}
```

## 2. Create the D1 database

```bash
wrangler d1 create vite-react-drizzle
# Paste the database_id into wrangler.jsonc
```

## 3. Deploy

```bash
npm run build
wrangler deploy
```

That's it. The same `dist/_worker.mjs` Creek would have deployed is what
`wrangler deploy` ships. Cookies, sessions, business logic — identical.

## What you'd lose

- Auto-provisioning of D1/R2/KV (you do `wrangler d1 create` etc.)
- Per-deploy preview URLs (wrangler has its own preview model)
- Single-command deploy from a fresh checkout (need to set up bindings)

## What you'd keep

- Every line of business logic
- Same DB schema, same API surface, same client
- Local dev workflow — `pnpm dev` is unchanged

Portability is the floor, not the ceiling. If Creek goes away tomorrow,
this app is a `wrangler deploy` away from running on your own account.
