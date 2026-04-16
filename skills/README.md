# Agent Skills for Creek

[Agent Skills](https://agentskills.io/) for [Creek](https://creek.dev) —
the deployment platform that reduces Cloudflare's 200+ API primitives
to a single command.

## Install

```bash
npx skills add solcreek/creek/skills
```

The `skills` CLI supports subpath installation, so the skill ships
directly from the monorepo. No separate distribution repo to sync.

## Available skills

| Skill | Description |
|-------|-------------|
| [creek](creek/SKILL.md) | Deploy + diagnose + manage Creek projects — CLI, resources, logs, MCP. |

## Layout

The `creek` skill follows Anthropic's [progressive-disclosure
guidance](https://code.claude.com/docs/en/skills) — `SKILL.md` stays
lean (~120 lines with mental model, anti-patterns, quick triage, cheat
sheet), and topic-focused detail lives in `references/` files that
Claude loads on demand.

```
skills/creek/
├── SKILL.md                     entry + index of references
└── references/
    ├── commands.md              full command table + JSON output spec
    ├── deployment-modes.md      authenticated / sandbox / CI / --from-github
    ├── workflows.md             first-deploy / rollback / domain, frameworks
    ├── creek-toml.md            creek.toml reference + cron + queue
    ├── diagnosis.md             failure workflow + CK-code map + troubleshooting
    ├── observability.md         creek logs + build logs + MCP get_build_log
    ├── resources.md             creek db + team-owned databases + portable pattern
    └── github-setup.md          GitHub App install + connection
```

## Same content, two surfaces

The `.md` files here are the single source of truth for agent-facing
guidance. They drive:

1. **Filesystem skill** — installed via `npx skills add`, loaded by
   Claude Code / Cursor / Codex / OpenCode.
2. **MCP resources** — `mcp.creek.dev` exposes each reference file
   as `creek://skill/<name>` via `resources/list` + `resources/read`.
   Bundled into the MCP worker at deploy time via wrangler's Text
   module loader. Serves claude.ai users + API agents that can't
   load filesystem skills.

Edit the `.md` file once — both surfaces update on next deploy.

## Legacy install URL (deprecated)

The old URL `npx skills add solcreek/skills` is **deprecated**. The
standalone [`solcreek/skills`](https://github.com/solcreek/skills)
repo is frozen at its last pre-consolidation snapshot and will be
archived. Update any install scripts, docs, or READMEs to the
`solcreek/creek/skills` form above — the content lives here
alongside the code it describes, so it stays in sync by construction.

## Requires

- [Creek CLI](https://www.npmjs.com/package/creek) (`npm install -g creek`)
- An authenticated account for production deploys (`creek login`)

## License

Apache-2.0
