# Creek CLI — Failure Diagnosis

When a user says "my deploy failed" or "creek deploy didn't work",
follow this sequence. Don't guess — each step returns structured data
you can act on.

## 1. Pre-deploy check (if they haven't run it yet)

```bash
creek doctor --json
```

Returns findings with `CK-*` codes, severities, and concrete fixes.
Run before any deploy-not-even-attempted scenario. Common fires:
`CK-NO-CONFIG`, `CK-NOTHING-TO-DEPLOY`, `CK-RESOURCES-NO-WORKER`,
`CK-DB-DUAL-DRIVER-SPLIT`, `CK-SYNC-SQLITE`, `CK-PRISMA-SQLITE`.

A `creek.toml` with no `package.json` and no `index.html` is not
deployable. Dry-run reports `wouldDeploy: false` — add one of those
files; do not retry deploy.

## 2. Find the failed deployment

```bash
creek deployments --json                    # list, newest first
```

Scan for `status: "failed"` rows; note the `id`.

## 3. Read the build log

```bash
creek deployments logs <id-prefix> --json
```

Look at `metadata.errorCode` and `metadata.errorStep`. The `entries`
array is phase-grouped — lines with `level: "error"` or from the
failing step are the signal.

## 4. Apply the fix

Match `errorCode` against the CK-* mapping:

| Code | Fix |
|------|-----|
| `CK-NO-CONFIG` | Run `creek init` or cd to a project root |
| `CK-NOTHING-TO-DEPLOY` | Run the build, or set `[build].command`; server code / API routes also need `[build].worker` |
| `CK-RESOURCES-NO-WORKER` | Resources declared but no worker entry — deploy is a static SPA, `/api/*` serves index.html. Set `[build].worker` (e.g. `worker = "worker/index.ts"`) |
| `CK-WORKER-UNDECLARED` | Worker file exists but isn't declared — point `[build].worker` at it |
| `CK-DB-DUAL-DRIVER-SPLIT` | Consolidate to shared `schema.ts` + `routes.ts` + thin boot split (see `references/resources.md`) |
| `CK-SYNC-SQLITE` | Move to async ORM (Drizzle/Kysely) with a D1 adapter |
| `CK-PRISMA-SQLITE` | Prisma+SQLite not supported on Workers; switch to Drizzle/Kysely |
| `CK-RUNTIME-LOCKIN` | Drop the `@solcreek/*` runtime imports for a portable build |
| `CK-CONFIG-OVERLAP` | Keep either creek.toml or wrangler.*, not both |

For an unmapped error code or a generic `build_failed`, the
`errorStep` tells you the phase (install / build / bundle) and the
log entries carry the actual stderr.

## 5. Redeploy

```bash
creek deploy --sandbox --json     # preview
creek deploy --prod --json        # production (requires sign-in)
creek verify <url> --json         # after sandbox
```

If the fix was config-side, `creek doctor --json` should now be clean.

A non-TTY `creek deploy --json` without `--sandbox`/`--prod` returns
`confirmation_required` — that is not a platform outage. Re-run with
an explicit target.

## Troubleshooting (error-string table)

Quick lookup when the user reports a specific error string verbatim.

| Error | Fix |
|-------|-----|
| "Not authenticated" | `creek login --token <KEY> --json` or set `CREEK_TOKEN` (agents: never `creek login` — it returns `interactive_login_unsupported`) |
| `interactive_login_unsupported` | Pass `--token <KEY>` |
| `confirmation_required` | Pass `--sandbox` or `--prod` |
| "Invalid API key" | `creek login --token <KEY>` to re-authenticate |
| "No creek.toml found" | `creek init` or cd to project root |
| `no_package_json` | Add `index.html` (static) or a `package.json`; `creek.toml` alone is not enough |
| "No project found" | Deploy from a dir with package.json or index.html |
| "No supported project found in repo" | Use `--path` for monorepos |
| "Project has no GitHub connection" (on `--from-github`) | Connect the repo first via the dashboard Settings → GitHub Connection |
| "Could not determine target project" (on `--from-github`) | Pass `--project <slug>` or run the command from a directory with a `creek.toml` |
| Sandbox expired | Redeploy — sandboxes last 60 minutes |
| Domain stuck "pending" | Set the records from `creek domains show <host> --json` (CNAME → `cname.bycreek.com`), then `creek domains activate` |
| Build fails | Check `[build] command` in creek.toml |
| Webhook not firing on push | Verify the repo is connected under project Settings; GitHub App must be installed on the repo's account |
| `CK-DB-DUAL-DRIVER-SPLIT` from `creek doctor` | Consolidate db.local.ts + db.prod.ts to the shared-routes pattern. See `references/resources.md`. |
| "Resource has bindings" on `creek db delete` | Detach from every project (`creek db detach <name> --from <project>`) before deletion |
| "X is attached to a … resource, but the bundle declares it as …" (409 `binding_conflict` on deploy) | The project already binds that name to another type of resource. Rename the binding in your config, or detach the old binding first: `creek <kind> detach <resource> --from <project> --as X` for a database, storage or cache (`--as` names the binding; without it the kind's default name is detached), or MCP `detach_resource` / the dashboard's project Bindings panel for any kind, Workers AI included. Nothing was deployed or created |
| "X is both a binding and a project environment variable" / "… a [vars] value" / "both a project environment variable and a [vars] value" (409 `binding_conflict`) | A worker's env holds one value per name, so an environment variable (for this deploy's target), a `[vars]` entry and a binding cannot share one. Rename one, or `creek env rm X`. A `--target preview` variable only collides with preview deploys |
| "X is a name Creek sets on every worker" (409 `binding_conflict`) | `CREEK_PROJECT_SLUG`, `CREEK_PROJECT_ID`, `CREEK_REALTIME_URL` and `CREEK_REALTIME_SECRET` are Creek's. Rename your variable or binding |
| "X is declared as both … and …" (409 `binding_conflict`) | Two bindings in your config share a name — or a framework adapter (Astro's `IMAGES`, `LOADER`) needs a name your config already uses for another type. Give each its own name |
| "X is … but the bundle declares it as images/worker_loader, which deploys do not bind" (409 `binding_conflict`) | A framework adapter needs a binding Creek does not provision, under a name the project already uses (an attached resource, or the `DB`/`KV` alias of `DATABASE`/`CACHE`). Rename or detach that binding |
| "A resource named 'X' already exists" | Team-unique names; pick a different one or `creek db rename` the existing one |
