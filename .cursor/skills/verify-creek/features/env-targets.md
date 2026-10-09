# Environment variable targets

An environment variable applies to production deploys, preview (branch) deploys, or all deploys. A key can hold one value per target; `creek env ls` shows each value's target and `creek env rm --target` removes one of them. The CLI refuses to report success when the server ignored a target.

## Sub-features

- `set-target` stores a value for `--target production`, `preview` or `all` (default).
- `invalid-target` refuses an unknown `--target` before any request.
- `ls-targets` lists one entry per key and target.
- `rm-target` removes one target's value; `rm` without `--target` removes every value of the key.
- `dry-run` plans `set`/`rm` with the target and the deploys that pick the change up.

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
- **Proof.** Keep the evidence directories and the SQL reads.

## Gotchas

- Which value a deploy gets is decided in the deploy job (production deploy: `production`, else `all`; branch deploy: `preview`, else `all`). The local control-plane cannot reach Cloudflare to finish a deploy, so prove that in `packages/control-plane/src/modules/env/env-targets.test.ts`, which runs the real deploy job and reads the worker's bindings.
- The default target is `all`; an unflagged `env set` behaves as before targets existed.
- `--show` on `env ls` prints the server's placeholder, not the value: values never leave the API.
