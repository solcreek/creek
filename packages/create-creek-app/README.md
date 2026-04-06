# create-creek-app

[![npm version](https://img.shields.io/npm/v/create-creek-app)](https://www.npmjs.com/package/create-creek-app)
[![license](https://img.shields.io/npm/l/create-creek-app)](https://github.com/solcreek/creek/blob/main/LICENSE)

Scaffold a new [Creek](https://creek.dev) project from a template — deploy to the edge in two commands.

## What is Creek?

Creek is a deployment platform built on [Cloudflare Workers](https://developers.cloudflare.com/workers/). It replaces the manual setup of `wrangler.toml`, bindings, and resource provisioning with a single `creek.toml` config and zero-config CLI.

- **`creek.toml`** replaces `wrangler.toml` — Creek manages Workers, routes, and bindings for you
- **`creek deploy`** replaces `wrangler deploy` — one command provisions D1 databases, KV namespaces, R2 buckets, and deploys your code
- **You own the Cloudflare account** — Creek deploys to your CF account via OAuth, no vendor lock-in

If you already use Wrangler, Creek is a higher-level abstraction. If you're new to Cloudflare, Creek is the fastest way to get started.

## Prerequisites

- **Node.js 18+** (LTS recommended)
- **Cloudflare account** — free tier works. Not needed for scaffolding, only for `creek deploy` (you'll be prompted to sign in via OAuth on first deploy)

> **`creek` vs `create-creek-app`**: `create-creek-app` scaffolds a new project. `creek` is the CLI that deploys, runs dev server, and manages your project. Both are installed on-demand via `npx`.

## Quick Start

```bash
# 1. Scaffold a landing page
npx create-creek-app my-site --template landing --yes

# 2. Local development
cd my-site && npx creek dev
# → http://localhost:5173 with hot reload

# 3. Deploy to production
npx creek deploy
# → https://my-site-your-team.bycreek.com (live in ~10 seconds)
```

You get a globally distributed site on Cloudflare's edge network, with optional D1 database, KV storage, R2 files, AI inference, and Realtime WebSockets — all managed by Creek.

## Usage

### Interactive (human)

```bash
npx create-creek-app
# prompts: template → project name → scaffold → install → git init
```

### Non-interactive (agent / CI)

```bash
npx create-creek-app my-blog --template blog --data '{"name":"Alice"}' --yes
```

### From a JSON config file

```bash
npx create-creek-app my-site --template landing --data-file config.json --yes
```

```json
// config.json
{
  "title": "Acme Corp",
  "tagline": "The best widgets",
  "theme": "light",
  "features": [
    { "title": "Fast", "description": "Edge-powered performance" },
    { "title": "Secure", "description": "Built-in DDoS protection" }
  ]
}
```

### Template discovery

```bash
# List all templates
npx create-creek-app --list
```

```json
[
  { "name": "blank", "description": "Minimal Creek project (no UI)", "capabilities": [] },
  { "name": "landing", "description": "Landing page with hero and CTA", "capabilities": [] },
  { "name": "blog", "description": "Blog with posts (D1 database)", "capabilities": ["d1"] },
  ...
]
```

```bash
# Print a template's JSON Schema
npx create-creek-app --template landing --schema
```

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "title": { "type": "string", "default": "My Product" },
    "theme": { "type": "string", "enum": ["light", "dark"], "default": "dark" }
  }
}
```

```bash
# Validate data before scaffolding
npx create-creek-app --template landing --validate --data '{"theme":"dark"}'
# → { "valid": true, "errors": [] }
```

### Third-party templates

```bash
npx create-creek-app --template github:user/my-template
```

## Options

```
npx create-creek-app [dir] [options]

  dir                                     Project directory (default: prompted or "my-creek-app")

  -t, --template <name|github:user/repo>  Template to use
  --data <json>                           JSON data for template params
  --data-file <path>                      JSON file for template params
  --list                                  List available templates (JSON)
  --schema                                Print template JSON Schema
  --validate                              Validate data against schema
  --registry <url>                        Private template registry (enterprise)
  -y, --yes                               Skip prompts, use defaults
  --no-install                            Skip dependency installation
  --no-git                                Skip git init
```

## Templates

Each template is a complete, deployable project — not a skeleton. Capabilities indicate which Creek-managed resources are pre-configured:

| Template | Description | Capabilities |
|----------|-------------|-------------|
| `blank` | Minimal Creek project (no UI) | — |
| `landing` | Landing page with hero and CTA | — |
| `blog` | Blog with posts | D1 database |
| `link-in-bio` | Social links page | — |
| `api` | REST API with Hono | D1 database |
| `todo` | Realtime todo app | D1 + WebSocket |
| `dashboard` | Data dashboard | D1 + WebSocket |
| `form` | Form collector | D1 database |
| `chatbot` | AI chatbot | D1 + Workers AI |

**Capabilities explained:**
- **D1** — SQLite database at the edge, managed by Creek (no connection strings, no migrations)
- **Realtime** — WebSocket connections via Creek's Realtime service (presence, broadcast)
- **AI** — Inference via Cloudflare Workers AI (LLMs, embeddings, image generation)

## Template Schema

Each template defines customizable parameters via [JSON Schema](https://json-schema.org/) in `creek-template.json`. This enables both human prompts and programmatic validation.

### creek-template.json

```json
{
  "name": "landing",
  "description": "Landing page with hero, features, and CTA",
  "capabilities": [],
  "schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "title": { "type": "string", "default": "My Product" },
      "tagline": { "type": "string", "default": "Ship faster with Creek" },
      "theme": {
        "type": "string",
        "enum": ["light", "dark"],
        "default": "dark"
      }
    }
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Template identifier |
| `description` | string | yes | Short description |
| `capabilities` | string[] | yes | Creek resources used: `d1`, `kv`, `r2`, `ai`, `realtime` |
| `thumbnail` | string | no | Path or URL to thumbnail image (400x300 recommended) |
| `screenshot` | string | no | Path or URL to full screenshot image |
| `schema` | object | no | JSON Schema defining customizable parameters |

### creek-data.json

Default values for the schema parameters. Your app reads this file at runtime — no build-time string replacement. Users customize their project by editing this one file.

```json
{
  "title": "My Product",
  "tagline": "Ship faster with Creek",
  "theme": "dark"
}
```

```tsx
// src/App.tsx — reads config at runtime
import data from "../creek-data.json";

export function App() {
  return <h1>{data.title}</h1>;
}
```

## Validation

Data is validated against the template's JSON Schema using [ajv](https://ajv.js.org/). Validation runs automatically during scaffold and can be triggered independently with `--validate`.

### Supported constraints

- **type** — `string`, `number`, `integer`, `boolean`, `array`, `object`
- **enum** — fixed set of allowed values
- **default** — applied when the property is omitted
- **required** — within object items (array entries, nested objects)
- **items** — schema for array elements
- **nested objects** — full recursive validation

### Validation examples

```bash
# Valid — passes (exit code 0)
npx create-creek-app --template landing --validate --data '{"theme":"dark"}'
# → { "valid": true, "errors": [] }

# Invalid enum — fails (exit code 1)
npx create-creek-app --template landing --validate --data '{"theme":"invalid"}'
# → { "valid": false, "errors": [{ "path": "/theme", "message": "must be equal to one of the allowed values" }] }
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error — validation failure, invalid arguments, scaffold failure, or network error |

All structured output (`--list`, `--schema`, `--validate`) goes to **stdout** as JSON. Progress messages and errors go to **stderr**.

## Creating Custom Templates

A Creek template is a directory with at minimum a `package.json` and `creek.toml`. Add `creek-template.json` for schema-driven customization.

### Template structure

```
my-template/
├── creek-template.json       ← schema + metadata (removed on scaffold)
├── creek-data.json           ← default values (optional)
├── creek.toml                ← Creek project config
├── package.json
├── src/                      ← your code
├── worker/index.ts           ← edge worker (if needed)
└── .gitignore
```

### Best practices

1. **Use JSON Schema defaults** — every property should have a `default` so the template works without any `--data`
2. **Read config at runtime** — import `creek-data.json` in your code instead of build-time placeholders
3. **Keep schemas flat** — prefer top-level string/number/boolean properties
4. **Use `enum` for constrained choices** — themes, layouts, color schemes. Agents discover valid options via `--schema`
5. **Include a `name` property** — `create-creek-app` auto-populates it from the project directory

### Publishing

Host your template on GitHub and use it directly:

```bash
npx create-creek-app --template github:yourname/my-template
```

Or submit it to the [Creek template gallery](https://github.com/solcreek/templates) via pull request.

## Agent Workflow

`create-creek-app` is designed for both humans and AI agents. Typical agent flow:

```bash
# 1. Discover templates
npx create-creek-app --list
# → JSON array to stdout

# 2. Read schema for chosen template
npx create-creek-app --template landing --schema
# → JSON Schema to stdout

# 3. Validate generated data
npx create-creek-app --template landing --validate --data '{"title":"Acme","theme":"dark"}'
# → { "valid": true, "errors": [] }

# 4. Scaffold
npx create-creek-app my-site --template landing --data '{"title":"Acme"}' --yes

# 5. Deploy
cd my-site && npx creek deploy --yes
# → { "ok": true, "url": "https://my-site-team.bycreek.com", ... }
```

All discovery and validation commands output JSON to stdout for programmatic consumption. Use `--yes` to skip all interactive prompts.

## Contributing Templates

The template ecosystem is open to everyone. We welcome contributions from individual developers, agencies, and framework authors.

### How to submit

1. Fork [solcreek/templates](https://github.com/solcreek/templates)
2. Create your template directory following the [template structure](#template-structure)
3. Ensure it scaffolds and deploys cleanly: `npx create-creek-app test-dir --template ./your-template --yes && cd test-dir && creek deploy`
4. Open a pull request

### Acceptance criteria

- **Works out of the box** — `--yes` with no `--data` must produce a deployable project
- **Has `creek-template.json`** — with description, capabilities, and schema (if customizable)
- **No secrets or API keys** — templates must not require external service credentials to scaffold
- **English** — template names, descriptions, and code comments in English

### Template tiers

| Tier | Badge | Maintained by | Review |
|------|-------|--------------|--------|
| **Official** | `solcreek/templates` | Creek team | Creek team review |
| **Community** | `github:author/repo` | Author | Self-published, no review required |

Official templates are held to a higher standard: they must stay compatible with the latest Creek CLI and are tested in CI. Community templates can be used by anyone via `--template github:author/repo` — no approval process needed.

### Ideas for templates

We'd especially love to see:
- Framework-specific starters (Astro + Creek, SvelteKit + Creek)
- Industry verticals (restaurant menu, event page, portfolio)
- Backend patterns (webhook receiver, cron job, queue processor)

See the [templates repo](https://github.com/solcreek/templates) for the full contribution guide.

## License

Apache-2.0
