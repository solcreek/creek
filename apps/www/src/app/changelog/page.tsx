"use client";

import { motion } from "framer-motion";
import { Footer } from "@/components/footer";

const entries = [
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
