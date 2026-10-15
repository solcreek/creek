# Environment variable targets

An environment variable applies to production deploys, preview (branch) deploys, or all deploys. A key can hold one value per target; `creek env ls` shows each value's target and `creek env rm --target` removes one of them. The CLI refuses to report success when the server ignored a target.

## Sub-features

- `set-target` stores a value for `--target production`, `preview` or `all` (default).
- `invalid-target` refuses an unknown `--target` before any request.
- `ls-targets` lists one entry per key and target.
- `rm-target` removes one target's value; `rm` without `--target` removes every value of the key.
- `dry-run` plans `set`/`rm` with the target and the deploys that pick the change up.
- `rm-rerun` re-running `rm` (or `unset`) on a key or target value that is gone succeeds with `alreadyAbsent: true`; `domains rm` does the same for a hostname.
- `write-only` `env ls` returns keys and targets, never values; `--show` refuses.

## How to get to it (user POV)

- Run `creek env set KEY VALUE --target production|preview|all`.
- Run `creek env ls`, `creek env rm KEY [--target T]`.
- MCP `env_set` / `env_rm` take the same `target`; the dashboard env page has a target selector.

## Driving it with verify-creek

Preconditions:

- A local control-plane: `LOCAL_ENV=$(.cursor/skills/verify-creek/scripts/control-plane.sh start "$RUN_ENV")` (see [API key scopes](api-key-scopes.md) for the helper).
- `control-plane.sh signup "$RUN_ENV" owner@example.com`, a project row `site` in the owner's team, a key from `control-plane.sh key "$RUN_ENV" owner@example.com legacy`, and `creek.sh "$RUN_ENV" -- init site --yes --json` for `creek.toml`.
- `creek.sh "$LOCAL_ENV" -- login --token <key> --json`.

- **Set per target.** `-- env set STRIPE_KEY sk_default --json`, then `... sk_live --target production --json`, then `... sk_test --target preview --json`. Each exits `0` with `target` echoed (`all`, `production`, `preview`).
- **Invalid target.** `-- env set STRIPE_KEY x --target staging --json` exits `1` with `error: "invalid_target"`.
- **List.** `-- env ls --json` lists `STRIPE_KEY` three times with targets `all`, `preview`, `production`. `control-plane.sh sql "$RUN_ENV" "SELECT key, target, encryptedValue LIKE 'sk_%' FROM environment_variable"` shows three rows and no plaintext.
- **Remove one target.** `-- env rm STRIPE_KEY --target preview --dry-run --json` plans `targets: ["preview"]`; without `--dry-run` it exits `0` with `removedValues: 1`; `env ls` no longer lists the preview value.
- **Remove every target.** `-- env rm STRIPE_KEY --json` exits `0` with `removedValues: 2`; the table has no `STRIPE_KEY` rows.
- **Re-run a removal.** Run each command twice. `-- env rm OLD_KEY --json`: first `alreadyAbsent: false, removedValues: 1`, then exit `0` with `alreadyAbsent: true, removed: false, removedValues: 0`; `-- env unset OLD_KEY --json` the same. `-- env rm K --target production --json` twice likewise. `-- env rm K --dry-run --json` on a gone key: `wouldExecute: false, alreadyAbsent: true`. `-- env rm K --project nosuch --json` exits `1` with `rm_failed` (a missing project is not `alreadyAbsent`). For domains: `-- domains add app.example.com --json`, then `-- domains rm app.example.com --json` twice (`alreadyAbsent: false`, then `true`), and `-- domains rm https://app.example.com --json` exits `1` with `not_found` (not a hostname) (verified 2026-10-15).
- **Write-only values.** `-- env ls --json` has `valuesWriteOnly: true` and `vars[]` with `key` and `target` only; `-- env ls --show --json` exits `1` with `error: "values_write_only"` (verified 2026-10-15).
- **Proof.** Keep the evidence directories and the SQL reads.

## Gotchas

- Which value a deploy gets is decided in the deploy job (production deploy: `production`, else `all`; branch deploy: `preview`, else `all`). The local control-plane cannot reach Cloudflare to finish a deploy, so prove that in `packages/control-plane/src/modules/env/env-targets.test.ts`, which runs the real deploy job and reads the worker's bindings.
- The default target is `all`; an unflagged `env set` behaves as before targets existed.
- Values never leave the API. The API's list still sends `value: mask(key)` (the key name masked, for older CLIs and the dashboard); the CLI drops it, and `--show` refuses with `values_write_only` (a CLI before this change printed that placeholder as the value).
- `alreadyAbsent: true` doesn't prove the key or hostname ever existed: removed rows leave no record, so a typo looks the same.
