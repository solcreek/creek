# Creek CLI — Common Workflows

Non-interactive environments (agents, CI, pipes) **must** pass `--sandbox` or `--prod`. `--json` alone is not enough; the CLI returns `confirmation_required`.

## First deploy (no account)

```bash
creek init --json                      # optional; writes creek.toml only
# Add index.html or a real app (package.json). creek.toml alone will not deploy.
creek deploy --dry-run --json          # read wouldDeploy + nextStep
creek deploy --sandbox --json          # 60-min preview
creek verify <url> --json              # confirm the URL is live
```

`creek init` does not create a deployable site. Dry-run reports `wouldDeploy: false` until there is an `index.html` or `package.json`.

## First deploy (signed in, production)

```bash
creek login --token <KEY> --json       # or CREEK_TOKEN; do not use browser login in agents
creek deploy --dry-run --json
creek deploy --prod --json
```

## Update & rollback

```bash
creek deploy --prod --json             # Deploy new version
creek deployments --json               # View history
creek rollback --dry-run --json        # See which deployment would become production
creek rollback --json                  # Previous real deploy (skips triggerType=rollback rows)
creek rollback <ID> --json             # Rollback to specific deployment
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
for the current compatibility matrix. Next.js requires
`@solcreek/adapter-creek`.

## Config Detection Order

1. `creek.toml` — explicit Creek config
2. `wrangler.jsonc` / `wrangler.json` / `wrangler.toml` — existing CF config
3. `package.json` — framework auto-detection
4. `index.html` — static site
