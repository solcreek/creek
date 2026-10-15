# Deploy bindings

A deploy binds every resource the project's config declares, under the name the config gives it: D1, R2, KV and Workers AI alike. A name the project already binds to another type of resource stops the deploy with `binding_conflict` before anything is staged or created, as does one name declared with two types.

## Sub-features

- `custom-ai-name` binds Workers AI under the declared name (`ai.binding = "MODEL"` → `env.MODEL`).
- `type-conflict` refuses a declaration whose type differs from the resource bound under that name (409 `binding_conflict`), with no deploy and no Cloudflare call.
- `duplicate-name` refuses one name declared with two types.
- `text-collision` refuses an environment variable (for the deploy's target) or a `[vars]` entry named like a binding, like each other, or like Creek's `CREEK_*` names.

## How to get to it (user POV)

- `creek deploy --prod --yes --json` from a project with `wrangler.jsonc` (`ai`, `d1_databases`, `kv_namespaces`, `r2_buckets`) or `creek.toml` `[resources]`.
- A GitHub push deploy and an MCP deploy upload the same bundle to the same endpoint.

## Driving it with verify-creek

Preconditions:

- `RUN_ENV=$(.cursor/skills/verify-creek/scripts/launch.sh)`.
- A local control-plane that answers Cloudflare in-process, so deploy jobs finish: `LOCAL_ENV=$(VERIFY_CREEK_FAKE_CLOUDFLARE=1 .cursor/skills/verify-creek/scripts/control-plane.sh start "$RUN_ENV")`. Every Cloudflare request is recorded in `$VERIFY_CREEK_RUN/control-plane/cloudflare-calls.ndjson`; a worker upload's line carries its `metadata.bindings`.
- `control-plane.sh signup "$RUN_ENV" owner@example.com`, a key from `control-plane.sh key "$RUN_ENV" owner@example.com legacy`, and `creek.sh "$LOCAL_ENV" -- login --token <key> --json`.
- In `$VERIFY_CREEK_WORK`: `src/index.js` (any module worker), `wrangler.jsonc` with `"main": "src/index.js"`, `"ai": { "binding": "MODEL" }` and `"d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "x" }]`, and `node_modules/creek` symlinked to `packages/creek` (the CLI's worker wrapper imports it).

- **Custom AI name.** `-- deploy --prod --yes --json`. `control-plane.sh sql "$RUN_ENV" "SELECT status FROM deployment"` is `active`. In `cloudflare-calls.ndjson`, both script uploads (`<project>-<id>-<team>` and `<project>-<team>`) carry `{"type":"ai","name":"MODEL"}` and `{"type":"d1","name":"DB"}`, and no `ai` binding named `AI`.
- **Type conflict.** Change `wrangler.jsonc` to `"ai": { "binding": "DB" }` (no `d1_databases`), empty `cloudflare-calls.ndjson`, `-- deploy --prod --yes --json`. Exits `1` with the message `DB is attached to a database resource, but the bundle declares it as ai`. The new deployment stays `queued`; `cloudflare-calls.ndjson` stays empty; the `DB` resource row is unchanged.
- **Duplicate name.** A raw `PUT /projects/<slug>/deployments/<id>/bundle` with `bindings: [{type:"kv",bindingName:"DATA"},{type:"r2",bindingName:"DATA"}]` answers 409 `binding_conflict` naming `DATA`. (The CLI's config parsing cannot produce this bundle.)
- **Text collision.** With `wrangler.jsonc` declaring `kv_namespaces: [{ "binding": "CACHE", "id": "x" }]` and `vars: { "MODE": "prod" }`, a first `-- deploy --prod --yes --json` makes the deployment `active`. Set a variable named like the binding with `-- env set CACHE x --json` (the project is the wrangler config's `name`); `-- deploy --prod --yes --json` exits `1` with `CACHE is both a binding and a project environment variable`, the new deployment stays `queued` and `cloudflare-calls.ndjson` stays empty. After `-- env rm CACHE --json`, a preview-only `-- env set MODE dev --target preview --json` does not stop a production deploy (`active`).
- **Proof.** Keep the evidence directories, the SQL reads and the extracted upload bindings.

## Gotchas

- The deploy itself is `active`, but `creek deploy` still exits `1` with `verify_failed`: its live check fetches `https://<project>-<team>.localhost`, which nothing serves. Read the deployment row, not the exit code.
- `creek deploy --json` reports the 409 as `error: "binding_conflict"` with `status: 409`, `apiError: "binding_conflict"` and `details.conflicts` (a CLI before 0.4.53 said `internal_error`, with only the message naming the conflict).
- In a wrangler-only project (no `creek.toml`), `creek env set/ls/rm` act on the wrangler config's `name`, the project `creek deploy` created; from any other directory pass `--project <slug>` (verified 2026-10-15). A CLI before this fix exited `no_project` there and rejected `--project` as `unknown_flag`: use raw `POST`/`DELETE /projects/<slug>/env` with it.
- `creek env ls` does not reveal values, and `--show` exits `1` with `values_write_only`: the API returns only a mask of the key name (`MY_KEY` → `MY_K****`), which a CLI before this change printed as the value (verified 2026-10-15).
- Without `VERIFY_CREEK_FAKE_CLOUDFLARE=1` the job fails at provisioning (no Cloudflare credentials), so the binding proof needs it. The upload-time 409 needs no Cloudflare and shows either way.
- `packages/control-plane/src/modules/resources/binding-plan.test.ts` runs 400 random project states through the upload check and the real job; `preview-bindings.test.ts` covers preview keys without `resource:write`.
