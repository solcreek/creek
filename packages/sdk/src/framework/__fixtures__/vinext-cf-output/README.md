# vinext Cloudflare build output fixture

Captured from a real `vite build` of a `create-vinext-app` project
(2026-10-06), so tests exercise the layout vinext actually emits rather
than a hand-written guess:

```sh
npx create-vinext-app@latest demo --platform=cloudflare \
  --data-cache=kv --cdn-cache=data-cache --image-optimization=none \
  --no-prerender --no-warm-cache --use-npm --yes
cd demo && npm run build   # vite build
```

Versions: vinext 1.0.1, @cloudflare/vite-plugin 2.0.0-beta.sha-52b0dc0e9,
cf 1.0.0-beta.12, vite 8.3.0.

The build writes its deployable output to
`.cloudflare/output/v0/workers/default/`. Files here, all relative to that
directory:

| file | content |
|---|---|
| `worker.config.json` | verbatim, from the project as generated |
| `worker.config.bindings.json` | verbatim, after adding `DB` (d1), `FILES` (r2), `AI`, `GREETING` (text) and `IMAGES` to `cloudflare.config.ts` and rebuilding |
| `worker.config.run-worker-first.json` | verbatim, after adding `runWorkerFirst: ["/_vinext/static-cache/*"]` to `assets` (what `vinext init --cdn-cache=static-assets` writes) and rebuilding |
| `files.txt` | every file path the build emitted |
| `assetsignore.txt` | verbatim `assets/.assetsignore` |
| `headers.txt` | verbatim `assets/_headers` |

The JavaScript itself is not committed (1.5 MB of generated code). Tests
recreate the tree from `files.txt` with placeholder contents; use
`materializeVinextFixture()` from `./materialize.ts`.
