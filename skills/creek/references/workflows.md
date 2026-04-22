# Creek CLI — Common Workflows

## First deploy

```bash
creek login --json                # 1. Authenticate
creek init --json                 # 2. Create creek.toml (optional)
creek deploy --json               # 3. Deploy
```

## Update & rollback

```bash
creek deploy --json               # Deploy new version
creek deployments --json          # View history
creek rollback --json             # Rollback to previous
creek rollback <ID> --json        # Rollback to specific deployment
```

## Custom domain

```bash
creek domains add app.example.com --json     # Add domain
# User sets DNS: CNAME app.example.com → cname.creek.dev
creek domains activate app.example.com --json # Activate after DNS
creek domains ls --json                       # Verify status
```

## Supported Frameworks

**SPA**: vite-react, vite-vue, vite-svelte, vite-solid, static HTML, astro
**SSR**: nextjs, react-router, sveltekit, nuxt, solidstart, tanstack-start

Not every SSR framework has equal support yet — check
[creek.dev/docs/getting-started](https://creek.dev/docs/getting-started)
for the current compatibility matrix. Next.js >= 16.2.3 is fully
supported via `@solcreek/adapter-creek` (`npm install` + `creek deploy`).

## Config Detection Order

1. `creek.toml` — explicit Creek config
2. `wrangler.jsonc` / `wrangler.json` / `wrangler.toml` — existing CF config
3. `package.json` — framework auto-detection
4. `index.html` — static site
