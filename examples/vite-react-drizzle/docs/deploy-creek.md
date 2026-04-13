# Deploy to Creek

```bash
npx creek@latest deploy
```

That's it. The first deploy will:

1. Run `npm run build` — Vite builds `dist/`, esbuild bundles
   `server/worker.ts` to `dist/_worker.mjs`.
2. Provision a fresh D1 database, bound as `env.DB`.
3. Upload `dist/_worker.mjs` as the Worker entry and the rest of `dist/`
   as static assets (served via `env.ASSETS`).
4. Print the preview URL.

Open the URL, add a todo. The worker's `ensureSchema()` runs on the first
`/api/*` request, so the table is created lazily.

## What Creek read from this project

- `creek.toml [build].command = "npm run build"` → build script
- `creek.toml [build].worker = "dist/_worker.mjs"` → Worker entry
- `creek.toml [resources].database = true` → provision D1 as `env.DB`
- `package.json` deps include `react`/`vite` → frontend mode

Future versions of Creek will infer `[resources].database = true`
automatically when `drizzle-orm/d1` or similar deps are present, so the
`creek.toml` will shrink further. For now, it's explicit.

## Iterating

```bash
npx creek deploy           # rebuild + redeploy
npx creek deployments      # see history
npx creek logs             # tail Worker logs
```

## What you don't see

- No `wrangler.jsonc` — Creek wires the bindings.
- No D1 database ID hardcoded anywhere — Creek tracks the binding by name.
- No `compatibility_date` — Creek picks a recent default.

If you want any of those, you can add a `wrangler.jsonc` and Creek will
respect it. They're optional, not hidden.
