# Resources v2 — Team-Owned Databases

Databases (and other resources) are **team-owned**, not project-owned.
A resource has a stable UUID and a mutable name; it can be attached
to one or more projects under different ENV var names. This replaces
the "one D1 per project, name derived from project id" model.

## Workflow

```bash
# 1. Create a team-level database (backing D1 is provisioned immediately; not yet attached to a project)
creek db create users --json

# 2. Attach it to one project as env.DATABASE
creek db attach users --to my-api --as DATABASE --json

# 3. Optionally share the same database with another project
creek db attach users --to dashboard --as DATABASE --json

# 4. Inspect what's attached
creek db ls --json
```

The database name is mutable — `creek db rename users --to prod-users`
works without recreating the CF resource or breaking bindings.

Deletion is blocked while any binding exists — detach from every
project first, then `creek db delete`.

## Re-running commands

`creek db|storage|cache create/attach/detach/delete` are safe to
re-run (e.g. after a timeout). Read the flags, not just `ok`:

| Command | Already in place → `ok: true`, exit 0 | Still an error, exit 1 |
|---|---|---|
| `create <NAME>` | Same kind, same name: `alreadyExists: true`, `resource` is the existing one (use its `id`) | Name held by another kind, or by a **deleted** resource (names stay reserved — choose another): `create_failed`, `apiError: "conflict"`, holder in `details.existing` (`id`, `kind`, `status`) |
| `attach <NAME> --to P --as B` | Same resource already bound as `B`: `alreadyExists: true`, `binding` | `B` bound to another resource: `attach_failed`, `apiError: "conflict"`, `details.existing` (`resourceId`, `kind`, `name`) — detach it first or pick another `--as` |
| `detach <NAME> --from P --as B` | `P` has no binding `B`: `alreadyAbsent: true` | Project `P` doesn't exist: `detach_failed`, `status: 404` |
| `delete <NAME>` | Already deleted: `alreadyAbsent: true`, `resource` (status `deleted`) | The team never had that name: `not_found` (check for a typo) |

`detach` checks only the binding name: `alreadyAbsent` means nothing
is bound as `B`, whichever resource it once was.

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
