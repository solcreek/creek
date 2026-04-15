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
`CK-NO-CONFIG`, `CK-NOTHING-TO-DEPLOY`, `CK-DB-DUAL-DRIVER-SPLIT`,
`CK-SYNC-SQLITE`, `CK-PRISMA-SQLITE`.

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
| `CK-NOTHING-TO-DEPLOY` | Run the build, or set `[build].command` in creek.toml |
| `CK-DB-DUAL-DRIVER-SPLIT` | Consolidate to shared `schema.ts` + `routes.ts` + thin boot split (see `references/resources.md`) |
| `CK-SYNC-SQLITE` | Move to async ORM (Drizzle/Kysely) with D1 adapter |
| `CK-PRISMA-SQLITE` | Prisma+SQLite not supported on Workers; switch to Drizzle/Kysely |
| `CK-RUNTIME-LOCKIN` | Drop the `@solcreek/*` runtime imports for a portable build |
| `CK-CONFIG-OVERLAP` | Keep either creek.toml or wrangler.*, not both |

For an unmapped error code or a generic `build_failed`, the
`errorStep` tells you the phase (install / build / bundle) and the
log entries carry the actual stderr.

## 5. Redeploy

```bash
creek deploy --json
```

If the fix was config-side, `creek doctor --json` should now be clean.

## Troubleshooting (error-string table)

Quick lookup when the user reports a specific error string verbatim.

| Error | Fix |
|-------|-----|
| "Not authenticated" | `creek login` or set `CREEK_TOKEN` |
| "Invalid API key" | `creek login` to re-authenticate |
| "No creek.toml found" | `creek init` or cd to project root |
| "No project found" | Deploy from a dir with package.json or index.html |
| "No supported project found in repo" | Use `--path` for monorepos |
| "Project has no GitHub connection" (on `--from-github`) | Connect the repo first via the dashboard Settings → GitHub Connection |
| "Could not determine target project" (on `--from-github`) | Pass `--project <slug>` or run the command from a directory with a `creek.toml` |
| Sandbox expired | Redeploy — sandboxes last 60 minutes |
| Domain stuck "pending" | Set CNAME to `cname.creek.dev`, then `creek domains activate` |
| Build fails | Check `[build] command` in creek.toml |
| Webhook not firing on push | Verify the repo is connected under project Settings; GitHub App must be installed on the repo's account |
| `CK-DB-DUAL-DRIVER-SPLIT` from `creek doctor` | Consolidate db.local.ts + db.prod.ts to the shared-routes pattern. See `references/resources.md`. |
| "Resource has bindings" on `creek db delete` | Detach from every project (`creek db detach <name> --from <project>`) before deletion |
| "A resource named 'X' already exists" | Team-unique names; pick a different one or `creek db rename` the existing one |
