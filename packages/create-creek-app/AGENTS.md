# create-creek-app — Agent Reference

You are interacting with `create-creek-app`, a CLI that scaffolds Creek projects from templates. Creek deploys to Cloudflare Workers.

## Capabilities

- Scaffold a new project from a built-in or third-party template
- Discover available templates and their schemas (JSON output)
- Validate template parameters before scaffolding
- Customize templates via JSON data (inline or file)

## Command Reference

All commands output JSON to **stdout**. Progress/errors go to **stderr**.

### Discovery (read-only, no side effects)

```bash
npx create-creek-app --list
```
Returns JSON array to stdout:
```json
[
  { "name": "blank", "description": "Minimal Creek project (no UI)", "capabilities": [] },
  { "name": "landing", "description": "Landing page with hero and CTA", "capabilities": [] },
  { "name": "blog", "description": "Blog with posts (D1 database)", "capabilities": ["d1"] }
]
```

```bash
npx create-creek-app --template landing --schema
```
Returns the template's JSON Schema to stdout:
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
npx create-creek-app --template landing --validate --data '{"theme":"dark"}'
```
Returns validation result to stdout:
```json
{ "valid": true, "errors": [] }
```
On failure:
```json
{ "valid": false, "errors": [{ "path": "/theme", "message": "must be equal to one of the allowed values" }] }
```

### Scaffold (creates files)

```bash
# Non-interactive scaffold
npx create-creek-app <dir> --template <name> --yes

# With custom parameters
npx create-creek-app <dir> --template <name> --data '<json>' --yes

# From a JSON config file
npx create-creek-app <dir> --template <name> --data-file <path> --yes

# Skip install and git init (faster, useful for testing)
npx create-creek-app <dir> --template <name> --yes --no-install --no-git

# Third-party template from GitHub
npx create-creek-app <dir> --template github:user/repo --yes
```

### Deploy (after scaffolding)

```bash
cd <dir> && npx creek deploy --yes
```

## Recommended Workflow

1. **`--list`** → pick a template based on description and capabilities
2. **`--schema`** → read the JSON Schema to know valid parameters
3. **`--validate`** → check your generated data (optional, scaffold validates too)
4. **Scaffold** with `--template`, `--data`, `--yes`
5. **Deploy** with `npx creek deploy --yes`

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (validation failure, bad arguments, network error) |

## Available Templates

| Name | Capabilities | Use when |
|------|-------------|----------|
| `blank` | — | Agent generates all code from scratch |
| `landing` | — | Marketing/product landing page |
| `blog` | D1 | Content site with database |
| `link-in-bio` | — | Social links page |
| `api` | D1 | REST API backend |
| `todo` | D1, Realtime | Full-stack app with WebSocket |
| `dashboard` | D1, Realtime | Data visualization with live updates |
| `form` | D1 | Form submissions with database storage |
| `chatbot` | D1, AI | AI-powered chat with conversation history |

## Template Parameters

Parameters are template-specific. Always run `--schema` to discover them. Common patterns:

- `name` — project name (auto-populated from directory name)
- `title`, `tagline`, `description` — display text
- `theme` — typically `"light"` or `"dark"` (enum-constrained)
- `accentColor` — hex color string
- `features` — array of `{ title, description }` objects

## What Creek Provides After Deploy

The scaffolded project deploys to Cloudflare's edge network via `creek deploy`. Depending on template capabilities:

- **All templates**: Global CDN, HTTPS, preview URLs
- **D1**: SQLite database — use `import { db } from "creek"` (no connection strings)
- **Realtime**: WebSocket — use `import { usePresence } from "creek/react"`
- **AI**: Workers AI — use `import { ai } from "creek"`

## Important Notes

- Always use `--yes` to skip interactive prompts
- The `--data` flag accepts inline JSON; use `--data-file` for complex data
- Templates use runtime config (`creek-data.json`) — users can customize after scaffold by editing this file
- `creek-template.json` is metadata only — it's removed from the scaffolded project
- No API keys or credentials needed for scaffolding; `creek deploy` handles auth via OAuth
