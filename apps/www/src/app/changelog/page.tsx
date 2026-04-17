"use client";

import { motion } from "framer-motion";
import { Footer } from "@/components/footer";

const entries = [
  {
    date: "2026-04-16",
    version: "cli@0.4.16 · creek@0.4.16",
    title: "Agent-first polish: five fixes for sandbox DB-backed deploys",
    items: [
      "**`creek init` now writes semantic resource keys.** Previously scaffolded `[resources] d1 = false / kv = false / r2 = false` — exactly the CF-native keys `creek doctor` flags as `CK-RESOURCES-KEYS` (silently dropped at deploy). Agents following the scaffolded output hit a wall at runtime with `env.DB` undefined. Now `init` omits `[resources]` entirely unless the user opts into a database, in which case it writes `database = true`. One less internal inconsistency between what the CLI generates and what it validates.",
      "**`creek deploy --dry-run` runs the full doctor rule set.** SKILL.md tells agents \"dry-run first,\" but the old dry-run silently returned `bindings: []` when the user wrote `d1 = true` instead of `database = true` — no warning, no blocker. Dry-run now runs the same SDK rule engine as `creek doctor`, surfacing `findings[]` (including `CK-RESOURCES-KEYS`, `CK-WORKER-MISSING`, etc.) in the JSON output and a concise error summary in human mode. The `nextStep` field changes to \"Fix N blocking issues first\" when any error-severity finding fires. Agents get the full pre-deploy picture in one call instead of discovering problems at runtime.",
      "**`sandbox-dispatch` passes through null-body statuses (204 / 205 / 304).** Worker handlers that returned `new Response(null, { status: 204 })` on PATCH/DELETE were hitting 500s: the dispatch layer's response-reconstruction path tried `new Response(body, ...)` on a null-body status, which the Fetch spec rejects. Banner injection would also corrupt the contract. Null-body statuses now short-circuit before any header mutation or body touch — only `X-Sandbox-Id` is added and the response returns as-is. Covered by three new regression tests.",
      "**SKILL.md adds a \"Sandbox with DB\" recipe.** Sandbox auto-provisions a D1 binding named `DB` when `creek.toml` declares `[resources] database = true` — no login, no `creek db create` required. The skill never said so, so agents building DB-backed demos hit a dead end at `creek db create`'s `not_authenticated` error and either abandoned DB or asked the user to log in. The recipe now lives near the top of the skill with a minimal `creek.toml` + `worker.ts` skeleton and three constraints (public/index.html required, dry-run first, `creek logs` needs auth). Triage table splits \"add a database\" into no-account vs signed-in rows.",
      "**The `creek` npm package now bundles the skill references.** SKILL.md told agents to `cat references/*.md` for deeper detail, but those files only lived in the monorepo — `npm install creek` gave you ENOENT on every documented lookup. A `prepack` script now copies the skill content into `packages/creek/skills/` before publish, so `node_modules/creek/skills/creek/SKILL.md` and the eight reference files (commands, creek-toml, deployment-modes, diagnosis, github-setup, observability, resources, workflows) ship with the package. Adds ~29KB to the tarball. The filesystem skill, MCP resources, and `llms.txt` now all resolve to the same files — one source of truth, bundled into every distribution channel.",
      "**Agent e2e validation.** Two rounds of end-to-end testing simulated a naive agent building a DB-backed TODO CRUD for sandbox. Before the five fixes, the path took ~8 steps of trial-and-error through config errors, missing scaffolding, and 500s with no log access. After: 3 steps from SKILL.md recipe to a live URL. The fixes above are what the delta pointed at.",
    ],
  },
  {
    date: "2026-04-16",
    version: "sdk@0.4.7 · cli@0.4.15 · creek@0.4.15",
    title: "Team-owned resources, creek db toolchain, PR preview comments",
    items: [
      "**Resources are now team-owned, not project-owned.** Databases, storage buckets, KV namespaces, and AI bindings are first-class entities with stable UUIDs and mutable names. One database can be attached to many projects; deleting a project no longer destroys its data. The old `project_resource` model has been hard-cut — no migration, no legacy path, just the clean model. This is the shape Heroku addons and Fly.io volumes have had for years; Creek now joins them from day one.",
      "**`creek db` is now a complete database toolchain.** Nine subcommands: `ls`, `create`, `attach`, `detach`, `rename`, `delete`, `shell` (interactive SQL REPL with `.tables` and `.schema`), `migrate` (apply pending `.sql` files with tracking + dry-run), and `seed` (execute a seed file). The migrate command auto-detects Drizzle's `drizzle/` directory, splits by `--> statement-breakpoint` markers, tracks applied state in a `_creek_migrations` table, and stops on first failure with exact position reporting.",
      "**`creek storage` and `creek cache` CLI commands.** Same CRUD shape as `creek db` — ls, create, attach, detach, rename, delete. All three resource CLIs share a single factory (`resource-cmd.ts`), so behavior and flags are identical across resource types.",
      "**PR preview comments.** When a GitHub push deploys a preview for a non-production branch, Creek now posts (or updates) a comment on the associated PR with the preview URL, build time, framework, and asset count. Uses a `<!-- creek-preview -->` marker for idempotent updates across force-pushes. Preview URL and build metadata are real deployment data, not placeholders.",
      "**MCP resource management — all 6 operations.** `list_resources`, `create_resource`, `attach_resource`, `detach_resource`, `rename_resource`, `delete_resource`. AI agents can now provision and wire databases without touching the CLI or dashboard.",
      "**Dashboard restructured.** Sidebar is now three groups: Platform (Projects), Resources (Database, Storage, Cache, AI), Account (Settings, API Keys). Each resource kind has its own page. Clicking a resource name opens a detail page showing CF metadata, attached projects, usage metrics, rename, and delete.",
      "**Resource usage metrics.** `GET /resources/:id/metrics` proxies to CF APIs — D1 returns database size + table count, R2 returns object count, KV returns key count. The dashboard detail page renders these as live metric cards with 60-second auto-refresh.",
      "**deploy-core test coverage: 0 to 38.** The deployment pipeline core (`hashAsset`, `sanitizeBranch`, `cfApi`, `deployScriptWithAssets`, D1/R2/KV resource operations) now has comprehensive unit tests. Previously untested.",
      "**Query API for team databases.** `POST /resources/:id/query` proxies SQL to the CF D1 HTTP API with team ownership validation, kind checking, provisioning status verification, and a 100KB query size limit. 9 endpoint tests covering all edge cases.",
    ],
  },
  {
    date: "2026-04-15",
    version: "Build logs · Resources v2 · Agent surface consolidation",
    title: "Close the loop on failed deploys — and stop agents from working around Creek",
    items: [
      "**Build logs shipped end-to-end.** Every `creek deploy`, every GitHub push deploy, and every `creek.dev/new` web deploy now produces a structured build log — phase-grouped (clone / detect / install / build / bundle / upload / provision / activate), with per-line severity, the failing step's CK-* code, and the original subprocess stderr. Content flows from the build-container's stdout through a secret-scrubbing + gzipping control-plane ingest endpoint to a per-tenant R2 prefix (30-day retention on success, 90 on failure, cron-purged). Readable three ways: the Dashboard's Deployments tab auto-expands the panel on any `failed` row with the failing step highlighted; `creek deployments logs <id>` gives a colour-coded terminal view with `--raw` for piping; and MCP's `get_build_log` tool returns a structured JSON summary so a coding agent can call it without a human intermediary.",
      "**Failure diagnosis now closes on itself.** `creek doctor --last` fetches the most recent failed deployment, reads its build log, and matches `errorCode` against a CK-code → fix table — printing the concrete next step without asking the user to copy deployment IDs around. The MCP `get_build_log` tool now ships a `suggestedFix` field for the same codes, so an agent using the MCP surface gets the fix inline with the log. One failed deploy, one command, one fix — instead of the previous \"check dashboard, copy id, run another command, read log, infer meaning, try something\" loop.",
      "**Resources v2: databases are team-owned and attachable.** `creek db create <name>` makes a team-level database resource with a stable UUID and a mutable semantic name. `creek db attach <name> --to <project> --as DB` binds it to one project under an ENV var name; attach it to a second project too if you want both to share the same data (the enterprise \"one prod-db, many apps\" shape Heroku / Fly.io / Render have expressed for years; Creek now joins them). Rename the database without recreating the CF resource or breaking bindings. Dashboard Settings → Resources shows all team resources with live attachment badges; each project gains a Bindings panel for attach / detach without wrangler.toml hand-edits.",
      "**Agent affordances: the CF-inheritance problem, fixed at four surfaces.** Coding agents kept proposing CF-native workarounds (\"swap `better-sqlite3` → D1 before deploy\", \"hand-edit wrangler.toml for D1 binding\", \"maintain parallel sandbox/prod code paths\") because they knew Creek runs on CF and applied CF reasoning. Each of those shortcuts is unnecessary on Creek and sends the user sideways. Fix landed in four coordinated places: an explicit \"What you DON'T need to do on Creek\" section near the top of creek.dev/llms.txt; a `CK-DB-DUAL-DRIVER-SPLIT` rule in `creek doctor` that detects split `db.local.ts` + `db.prod.ts` files and points at the correct shared-schema + thin-boot-split pattern; deploy-output anchors in `creek deploy` that preempt the wrong assumption before it forms; and a Mental Model + anti-patterns block at the top of the agent skill.",
      "**Skill v3.0: progressive disclosure, monorepo-backed.** The skill at `npx skills add solcreek/creek/skills` is restructured per Anthropic's official guidance. `SKILL.md` stays lean (~120 lines: mental model, anti-patterns, quick-triage table, agent rules, cheat sheet, references index). Topic-focused detail moves into `references/` (commands / deployment-modes / workflows / creek-toml / diagnosis / observability / resources / github-setup). Claude loads SKILL.md every time the skill matches; reference files load on demand via `bash cat`. Effective per-trigger context shrinks by roughly 78% while the total depth of available content grows — agents pay only for the section they need.",
      "**One source of truth across every agent surface.** The skill content used to live in the standalone `solcreek/skills` repo while the MCP server, the llms.txt file, and the doctor CK-code mapping lived in the main Creek repo. Four surfaces, four copies, manual sync. Consolidated this week into a single location (`skills/` at the monorepo root) with a three-channel distribution: the filesystem skill (`npx skills add solcreek/creek/skills`), MCP resources (`creek://skill/*` exposed by `mcp.creek.dev`, bundled into the worker at deploy time via wrangler's Text module loader), and the creek.dev/llms.txt Quick Triage + Failure Diagnosis playbook. Edit a `.md` once; all three surfaces pick it up on the next deploy. Architectural drift between what the skill says, what the MCP tool says, and what llms.txt says is now impossible by construction — not by discipline.",
      "**Unified Analytics tab is cache-aware.** Builds on yesterday's zone-analytics addition: the Dashboard's Analytics tab now shows *total* HTTP traffic (including CF-edge-cached requests that never invoked the worker) alongside worker-invocation specifics. Requests / Cache hit % / Invocations / Error rate / CPU p50 / p99 in one row. The stacked time-series chart breaks origin vs cached traffic visually. Edge caching is preserved — we layer the observability, not the other way round.",
      "**Deprecated: `npx skills add solcreek/skills`.** Use `npx skills add solcreek/creek/skills` instead. The old standalone repo is frozen and will be archived — its README now points at the monorepo location. No PAT-driven mirror glue; just one location where the content lives, next to the code it describes.",
    ],
  },
  {
    date: "2026-04-14",
    version: "Dashboard · api.creek.dev",
    title: "Cache-aware Analytics: see the traffic the worker never knew about",
    items: [
      "**Analytics tab now shows real visitor traffic — including the requests CF served from the edge cache.** A static SPA's index.html gets `cache-control: public, max-age=0, must-revalidate` from the Workers+Assets binding, and CF's edge fronts it with ETag-based revalidation: subsequent visits are answered at the edge without ever invoking the worker. Tail events only fire on worker invocations — by definition, cache hits are invisible to them. We were under-reporting traffic for every cached HTML response. Fixed by querying zone-level `httpRequestsAdaptiveGroups` from CF's GraphQL Analytics API alongside the existing Analytics Engine source. The Requests card is now the true number, and a Cache hit % card sits next to it so you can see how much of your traffic is being CDN-served vs hitting your worker.",
      "**Metrics and Analytics merged into a single Analytics tab.** Two tabs reading two data sources for overlapping numbers was confusing — same chart, slightly different totals depending on which side ran first. Six stat cards now live in one place: Requests (zone, all traffic), Cache hit (% served from edge), Invocations (worker runs), Error rate (errors / invocations — error rate quoted against invocations because cache hits physically can't error), CPU p50, CPU p99 (production deployment, from Workers GraphQL).",
      "**Stacked time-series chart.** When zone analytics is available, the requests-over-time chart stacks origin traffic on top and edge-cached traffic in a lighter shade — so you can see when a viral spike was actually CPU pressure on your worker vs just CDN passthrough. Falls back to the worker-invocations chart when zone data isn't available.",
      "**Period coverage expanded to 1h / 6h / 24h / 7d / 30d.** Both the AE-backed metrics endpoint and the Workers-GraphQL-backed analytics endpoint accept the same set, so switching periods recomputes everything coherently.",
      "**Per-deployment-type breakdown.** New visualizations for: HTTP method (GET / POST / …), deployment type (production / branch / preview), and status bucket (2xx / 4xx / 5xx). Driven by the Analytics Engine dataset the tail-worker has been writing since Phase 8. A noisy 4xx column is the fastest way to spot a broken redirect a user is hammering.",
      "**Logs tab note: edge-cached requests don't appear in logs.** This was the most-asked question — \"why don't I see GET / in my logs?\". Worker logs are by-definition worker invocations only; cached requests didn't run any code and have no `console.log` to show. Logs tab now says this explicitly with a deep link to the Analytics tab where total traffic (including cache hits) is visible.",
      "**Architectural alignment with CF's documented pattern.** Tail Workers are the right tool for invocation detail (CPU, exceptions, console output, sub-requests). Zone Analytics is the right tool for total request volume (cache + origin). We layer them, like CF's own dashboard does, instead of trying to make either one cover both jobs. Bonus: the layered model means tenants don't lose edge caching for the sake of observability — which would have been the most expensive false economy the platform could choose.",
    ],
  },
  {
    date: "2026-04-13",
    version: "cli@0.4.13 · creek@0.4.13 · sdk@0.4.5",
    title: "creek logs: per-tenant observability, live tail, WebSocket streaming",
    items: [
      "**`creek logs` — read your project's logs from the CLI.** Every `console.log`, `console.error`, and uncaught exception in every request your Worker served is captured, per-tenant, and archived for 7 days. Query by time range, outcome, deployment preview, branch, console level, or free-text search. Pipe to `jq` with `--json`. First day it was live it surfaced a latent `TypeError: Cannot read properties of undefined (reading 'fetch')` in a tenant's SPA fallback that had been quietly 500-ing for hours — the command paid for itself within a minute.",
      "**`creek logs --follow` — live tail via WebSocket.** Prints recent historical context first so you don't stare at an empty terminal waiting for traffic, then streams new entries as they arrive (until Ctrl+C). Dedup is automatic across the historical → live boundary. Pair with `--outcome exception` to get a live error feed, or pipe `--json | jq` straight into a notification webhook.",
      "**Per-tenant isolation is structural, not role-gated.** The R2 key prefix is server-derived as `logs/{team}/{project}/...` from the authenticated session — a user cannot read another team's logs even by forging URL params. Tested end-to-end against the `vite-react-drizzle` sample. Sensitive request headers (Authorization, Cookie, Set-Cookie) are redacted at ingest and never stored.",
      "**Deploy path unification.** `deploySandbox` and `deployAuthenticated` used to be two parallel implementations that drifted — the sandbox path was silently missing worker bundling for anyone who declared `[build].worker` but hadn't signed in. Replaced with a single `prepareDeployBundle()` helper driving both flows, and a pure `planDeploy()` resolver (SDK) with 17 table-driven test rows covering every combination of (framework × worker entry × build output). 'SPA framework + custom Worker' (the vite-react-drizzle shape) now deploys correctly with zero config changes.",
      "**Pre-bundled Worker shortcut.** When `[build].worker` points at a `.js/.mjs/.cjs` file inside the build output, the CLI uploads the bytes verbatim instead of re-bundling and wrapping with the Creek runtime. Lets portable apps (like the new `vite-react-drizzle` example) keep their deployed Worker free of any `@solcreek/*` dependency.",
      "**New example: `vite-react-drizzle`.** Reference for the 'same code runs locally against `better-sqlite3` and on Cloudflare against D1' pattern. Three files carry runtime differences (`server/local.ts`, `server/worker.ts`, `server/routes.ts` — the last one driver-agnostic). Everything else — schema, routes, frontend — is portable. Ships with `local-dev.md`, `deploy-creek.md`, and `migrate-away.md` documenting both the Creek happy path and how to leave Creek for plain `wrangler deploy`.",
      "**Sandbox rate limit 5 → 15/hr** for unverified users. Five deploys per hour wasn't enough to debug a template through a few iterations.",
      "**CLI regression fix (0.4.7 → 0.4.8).** `cli@0.4.7` shipped with a stale workspace pin to `sdk@0.4.2` that didn't export helpers the CLI imported at startup. Both `creek@0.4.7` and `@solcreek/cli@0.4.7` have been deprecated on npm — `npm install` auto-suggests 0.4.8+.",
    ],
  },
  {
    date: "2026-04-11",
    version: "cli@0.4.6 · creek@0.4.3 · sdk@0.4.2",
    title: "Install size −85%, Astro support, --dry-run, static-site fast path",
    items: [
      "**Install size cut from ~170MB to ~25MB** — `miniflare` (and its transitive deps `workerd` and `sharp`, which were ~146MB combined) is no longer a runtime dependency of `@solcreek/cli`. `creek deploy` never touched them anyway. First-time `npx creek deploy` now installs in ~3–5 seconds instead of ~20s, and the postinstall warnings that used to appear when `sharp`'s native build failed are gone. `creek dev` still uses miniflare but loads it on demand from the user's project / global npm / a creek-managed cache dir, with a zero-jargon error message if it's not installed.",
      "`creek deploy gh:owner/repo` shorthand — matches the `gh` CLI convention. `gh:`, `gl:` (GitLab), and `bb:` (Bitbucket) all work as short prefixes alongside the longer `github:` / `gitlab:` / `bitbucket:` forms.",
      "`creek deploy --dry-run` — new flag that reports a plan (resolved config, framework, build command, bindings, cron/queue, auth status, target type) without executing. No network calls, no file uploads, no ToS prompt. Pair with `--json` for agent-safe machine-readable output. Unsupported modes short-circuit cleanly.",
      "Astro framework detection — SDK now recognizes `astro` as a first-class framework. Any Astro 3+ project (SPA, SSG, MDX, content collections, sharp image optimization) auto-detects and builds via `astro build`. End-to-end tested against Astro 6 + Tailwind 4 + MDX + sharp (`jiseeeh/serene-ink` theme) — clone, install, build, 25 assets uploaded, live URL in ~15 seconds.",
      "Static-site sandbox fast path — a directory with only `index.html` (no `package.json`) now deploys cleanly. Previously crashed with ENOENT. The simplest possible onboarding works: `echo '<h1>Hi</h1>' > index.html && npx creek deploy`.",
      "Sandbox content scan allowlists common embed providers — YouTube, Vimeo, Wistia, Loom, Twitter/X, GitHub Gist, CodePen, CodeSandbox, StackBlitz, JSFiddle, Spotify, SoundCloud, Figma, Google Docs/Calendar/Maps, Typeform, Airtable, Notion. The previous regex-only check blocked every dev blog or portfolio that embedded a YouTube video; now the scan parses iframe `src` as a URL and allows known content-embed hosts (subdomain-aware) while still blocking unknown domains and phishing surfaces.",
      "Richer `creek deploy --help` output — `meta.description` and every flag description rewritten to spell out sandbox-vs-production behavior, auto-detection chain, and example invocations. Targets AI coding agents reading help on a cold paste so they can act confidently with fewer turns.",
      "`/llms.txt` rewritten with an explicit \"Paste-to-agent contract\" section describing what to do when a human pastes `npx creek deploy` with no surrounding context — what `--dry-run` returns, how to read exit codes, CLI conventions (`--json`, `--yes`, non-TTY auto-JSON), and the MCP server + agent-skill distribution channels.",
      "Agent discoverability caption: the hero under `npx creek deploy` now reads \"no signup · live in seconds · Claude + Codex + Cursor ready\". Empirical testing confirmed a cold Claude pasted with just `npx creek deploy` investigates safely (checks `--help`, scans config, asks for go/no-go) and completes the deploy in a few tool calls.",
      "Docs and breadcrumb scrub — every `--demo` reference across README, docs, pricing page, llms.txt, and internal error-path hints replaced with `creek deploy --template landing`, which actually works and gives users a real editable Vite + React starter (not a throwaway demo page).",
    ],
  },
  {
    date: "2026-04-11",
    version: "cli@0.4.4 · creek@0.4.1",
    title: "GitHub auto-deploy, remote build via connection",
    items: [
      "`creek deploy --from-github [--project <slug>]` — trigger a remote build of the latest commit on the production branch via the project's GitHub connection, no local build required",
      "GitHub App integration: install the `Creek Deploy` App, connect a repository from the dashboard, and pushes to main auto-deploy while PRs get preview URLs with commit status",
      "Dashboard Project → Settings → GitHub Connection: show the connected repo, disconnect, or pick a new one via installation + repo picker",
      "Dashboard Project → Deployments: `Deploy latest` button (same endpoint as the CLI flag), inline commit SHA + message with a link to the GitHub diff, expanded error + failed-step display when a deploy fails, live polling so new deployments appear without a manual refresh",
      "Server: new `POST /github/deploy-latest` endpoint, auto-resolve slug collisions on import (appends `-2`, `-3`, … when two repos share a name), `github_connection.repoId` column to survive repository renames / transfers, webhook handlers for `repository.renamed` and `repository.transferred`",
      "CLI: auto-accept PKCS#1 private keys when creating the GitHub App JWT (GitHub's default export format) — no more manual `openssl pkcs8 -topk8`",
      "Control-plane: `GITHUB_WEBHOOK_SECRET` validation hardened, returns 503 instead of 500 when unconfigured",
      "Better Auth upgraded 1.5.6 → 1.6.2 — picks up OAuth CSRF + Drizzle date/null fixes that were affecting the dashboard login flow",
      "`CAPABILITIES.md` at the monorepo root: a one-page index of what Creek can do today and where each capability lives across runtime SDK, `creek.toml`, CLI, MCP, dashboard, and agent skills",
      "Agent skills bumped to v2.2 (installable via `npx skills add solcreek/skills`) — documents `--from-github`, trigger schemas, semantic resource names, and the GitHub auto-deploy walkthrough",
    ],
  },
  {
    date: "2026-04-09",
    version: "runtime@0.4.0 · cli@0.4.2",
    title: "Cron, queues, analytics, semantic resource names",
    items: [
      "Cron triggers: declare `[triggers] cron = [\"0 */6 * * *\"]` in `creek.toml` and export a `scheduled()` handler — Creek wires the Cloudflare cron binding at deploy time",
      "Queue triggers: `[triggers] queue = true` provisions a per-project Cloudflare Queue, binds a `queue` producer at runtime (`import { queue } from 'creek'`), and invokes your exported `queue(batch, env, ctx)` consumer",
      "`creek queue send '<json-body>'` — inject a message into the project queue from the CLI",
      "`creek dev --trigger-cron \"* * * * *\"` — simulate a scheduled event firing during local development",
      "Per-tenant analytics tab in the dashboard: requests, errors, p50/p99 latency, plus a cron execution log pulled from the Cloudflare GraphQL Analytics API",
      "Semantic resource names in `creek.toml`: `database` / `storage` / `cache` / `ai` (the legacy `d1` / `kv` / `r2` / `ai` still work for backward compatibility)",
      "CLI worker-bundler now auto-generates `scheduled()` and `queue()` handler wrappers alongside `fetch()`",
      "`creek status` shows registered cron schedules and trigger config summary",
      "Request-scoped runtime bindings (D1, R2, KV, Queue) — multi-tenant safe by construction, no manual context threading",
    ],
  },
  {
    date: "2026-04-07",
    version: "cli@0.3.9",
    title: "First automated release + queue-driven web deploys",
    items: [
      "First npm publish triggered by a git tag: `cli@0.3.9` via the new GitHub Actions `publish-cli.yml` workflow",
      "Companion publish workflows added for `@solcreek/sdk`, `@solcreek/runtime`, `@solcreek/ui`, `create-creek-app`, and the `creek` umbrella",
      "Remote-builder reworked as a Queue consumer — web-deploy builds now flow through a Cloudflare Queue producer in control-plane + consumer in remote-builder instead of `waitUntil` sharing request lifetime",
      "`creek ops` command for platform monitoring: list recent web deploys across the cluster, grouped by project",
      "Sandbox schema rename: the `sandbox` table becomes `deployments` with an `environment` column — one model for sandbox previews, web deploys, and authenticated production deployments",
      "`@solcreek/runtime` split into `/react` and `/hono` subpath exports so CF Workers builds don't pay the React cost when they don't need it",
    ],
  },
  {
    date: "2026-03-27",
    version: "0.3.0-alpha.14",
    title: "Query commands, MCP server, docs site",
    items: [
      "`creek projects` / `creek deployments` / `creek status` — query your projects and deployments",
      "Remote MCP server at mcp.creek.dev — AI agents can deploy with a single tool call",
      "Documentation site at creek.dev/docs (powered by fumadocs)",
      "Bin aliases: `ck` and `crk` as shortcuts for `creek`",
      "llms.txt for AI agent discovery",
      "Distribution strategy and 21+ planning documents",
    ],
  },
  {
    date: "2026-03-27",
    version: "0.3.0-alpha.12",
    title: "Rate limit improvements, agent-first output",
    items: [
      "Rate limit raised to 10/hr, demo deploys exempt",
      "429 responses include `hint` field guiding users to `creek login`",
      "Global `--json` and `--yes` flags on all 10 commands",
      "Non-TTY environments auto-enable JSON output",
      "Malformed JSON requests return 400 (not 500)",
    ],
  },
  {
    date: "2026-03-27",
    version: "0.3.0-alpha.9",
    title: "Sandbox UX redesign",
    items: [
      "`creek deploy --demo` — zero-dependency instant deploy",
      "`creek deploy ./dist` — deploy any directory",
      "Empty directory shows helpful guidance instead of scaffold prompt",
      "Build output auto-detection (dist/, build/, out/)",
      "Removed interactive scaffold flow — Creek is a deploy platform, not a boilerplate generator",
    ],
  },
  {
    date: "2026-03-27",
    version: "0.3.0-alpha.1",
    title: "First public release",
    items: [
      "CLI published to npm as `creek`",
      "@solcreek/sdk published",
      "Security audit: shell injection, config permissions, XSS, env redaction",
      "Apache 2.0 license",
    ],
  },
  {
    date: "2026-03-26",
    version: "Internal",
    title: "MVP + Sandbox + Production infrastructure",
    items: [
      "Phase 0-2.5 completed: platform stabilization, auth, dashboard, production deploy",
      "Sandbox system: deploy, status, claim, delete, content scanning, WAF",
      "Banner with Shadow DOM, QR code, RWD",
      "OpenTofu managing 43+ Cloudflare resources",
      "creek.dev and app.creek.dev deployed via Creek (dogfooding)",
    ],
  },
];

export default function ChangelogPage() {
  return (
    <div className="flex flex-col flex-1">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-lg">
        <div className="mx-auto max-w-5xl flex items-center justify-between px-6 h-14">
          <a href="/" className="font-mono text-sm font-medium tracking-tight">
            creek
          </a>
          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            <a href="/docs" className="hover:text-foreground transition-colors">Docs</a>
            <a href="/pricing" className="hover:text-foreground transition-colors">Pricing</a>
            <a href="https://templates.creek.dev" className="hover:text-foreground transition-colors">Templates</a>
            <a href="/changelog" className="text-foreground">Changelog</a>
            <a href="https://github.com/solcreek/creek" className="hover:text-foreground transition-colors" target="_blank" rel="noopener noreferrer">GitHub</a>
          </div>
        </div>
      </nav>

      {/* Header */}
      <section className="px-6 pt-20 pb-12 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-3xl font-semibold tracking-tight"
        >
          Changelog
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mt-3 text-muted-foreground"
        >
          What's new in Creek.
        </motion.p>
      </section>

      {/* Entries */}
      <section className="mx-auto max-w-2xl px-6 pb-28">
        <div className="space-y-12">
          {entries.map((entry, i) => (
            <motion.article
              key={entry.version}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.4 }}
            >
              <div className="flex items-center gap-3 mb-3">
                <time className="font-mono text-xs text-muted-foreground">{entry.date}</time>
                <span className="text-xs font-mono text-accent border border-accent/30 rounded-full px-2 py-0.5">
                  {entry.version}
                </span>
              </div>
              <h2 className="text-lg font-semibold tracking-tight mb-3">{entry.title}</h2>
              <ul className="space-y-1.5">
                {entry.items.map((item) => (
                  <li key={item} className="text-sm text-muted-foreground leading-relaxed flex gap-2">
                    <span className="text-accent mt-1.5 shrink-0">-</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </motion.article>
          ))}
        </div>
      </section>

      <Footer />
    </div>
  );
}
