# Wrangler Config Test Fixtures

Real-world `wrangler.toml` / `wrangler.jsonc` files collected from popular open-source Cloudflare Workers projects. Used to test Creek's config auto-detection and parsing.

## How these are used

The test runner (`fixtures.test.ts`) automatically discovers every subdirectory here and runs:

1. **L1 Parse** — `resolveConfig(dir)` doesn't throw
2. **L1 Bindings** — Extracted bindings match `meta.json` expectations
3. **L2 Snapshot** — Full `ResolvedConfig` output matches saved snapshot
4. **L3 Dry-run** — Backward compat bridge produces correct `ResourceRequirements`

## Adding a new fixture

1. Create a directory: `my-project/`
2. Add the wrangler config: `wrangler.toml` (or `.json` / `.jsonc`)
3. Add `meta.json` with source attribution and expected bindings
4. Optionally add `package.json` if framework detection is relevant
5. Run `pnpm test` — the new fixture is auto-discovered

## License

Each fixture's source repo and license are recorded in its `meta.json`. All source repos are open-source (MIT, Apache-2.0, or similar). Config files are functional/factual content with minimal creative expression.
