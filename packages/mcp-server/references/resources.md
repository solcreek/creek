# Resources v2 — Team-Owned Databases

Databases (and other resources) are **team-owned**, not project-owned.
A resource has a stable UUID and a mutable name; it can be attached
to one or more projects under different ENV var names. This replaces
the "one D1 per project, name derived from project id" model.

## Workflow

```bash
# 1. Create a team-level database (unattached, not yet provisioned in CF)
creek db create users --json

# 2. Attach it to one project as env.DB
creek db attach users --to my-api --as DB --json

# 3. Optionally share the same database with another project
creek db attach users --to dashboard --as DB --json

# 4. Inspect what's attached
creek db ls --json
```

The database name is mutable — `creek db rename users --to prod-users`
works without recreating the CF resource or breaking bindings.

Deletion is blocked while any binding exists — detach from every
project first, then `creek db delete`.

## Portable pattern (required mental model)

Share **schema + queries**; split **only the boot**. The
`examples/vite-react-drizzle` reference:

```
server/
├── schema.ts    shared Drizzle schema (one source of truth)
├── routes.ts    shared Hono routes that accept a `() => db` thunk
├── local.ts     Node + better-sqlite3 boot (dev)
└── worker.ts    CF Worker + D1 boot (prod)
```

The async Drizzle API is the same across both drivers, so
`routes.ts` runs unchanged in either environment. Migrations run
against whichever driver the boot file sets up. Don't duplicate
schema or queries across `db.local.ts` + `db.prod.ts` — `creek doctor`
flags that with `CK-DB-DUAL-DRIVER-SPLIT`.
