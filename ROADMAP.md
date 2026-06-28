# Roadmap

Planned changes that affect how you use Creek. For changes already shipped,
see each package's CHANGELOG. Announced ahead of time so you can migrate before
they land.

## Toward 1.0 — breaking changes

### Resource binding env names

Resource binding env vars are named after their `creek.toml` key: `database` →
`env.DATABASE`, `cache` → `env.CACHE`, `storage` → `env.STORAGE`, `ai` →
`env.AI`.

Through the pre-1.0 deprecation window the older `env.DB` and `env.KV` aliases
still resolve alongside the new names. **They will be removed in v1.0.** Before
then, update your code to read `env.DATABASE` and `env.CACHE`, and attach
resources with `--as DATABASE` / `--as CACHE`.
