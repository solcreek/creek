# `creek.toml` Reference

```toml
[project]
name = "my-app"              # Required. Lowercase alphanumeric + hyphens.
framework = "nextjs"         # Optional. Auto-detected from package.json.

[build]
command = "npm run build"    # Build command (default: npm run build)
output = "dist"              # Build output directory
worker = "worker/index.ts"   # Optional: custom Worker entry point

[resources]
database = true              # D1 database   → env.DB    + `import { db } from 'creek'`
storage  = true              # R2 bucket     → env.BUCKET + `import { storage } from 'creek'`
cache    = true              # KV namespace  → env.KV    + `import { cache } from 'creek'`
ai       = true              # Workers AI    → env.AI    + `import { ai } from 'creek'`

[triggers]
cron  = ["0 */6 * * *"]      # One or more cron expressions. Standard 5-field format.
queue = true                 # Creates a per-project queue + consumer binding.
                             # Producer: `import { queue } from 'creek'` inside the Worker.
                             # Consumer: export a `queue(batch, env, ctx)` handler.
```

**Semantic names** (`database` / `storage` / `cache`) are the stable
Creek names and what you should write in new projects. The legacy
Cloudflare names (`d1` / `r2` / `kv`) are still accepted for
backward compatibility but deprecated.

**`[resources]` booleans vs `creek db`** — the `[resources]` shorthand
auto-provisions one resource per project, legacy-compatible with v1.
For any project needing a renameable database, a database shared
across projects, or explicit ENV var control, use `creek db create` +
`creek db attach` (see `references/resources.md`). The two paths can
coexist during migration.

## Cron triggers

Creek reads the `cron` array and registers each expression with
Cloudflare's scheduled event system. The Worker must export a
`scheduled(event, env, ctx)` handler. Creek generates this handler
automatically when using a framework; for hand-written Workers, see
the SSR/Worker examples in the docs.

Verify cron is active:
```bash
creek status --json          # Shows registered cron schedules
```

Simulate a firing locally during dev:
```bash
creek dev --trigger-cron "0 */6 * * *"
```

## Queue triggers

Setting `queue = true` auto-provisions a Cloudflare Queue and binds
it to the project. Inside the Worker:

```ts
// Producer — in any request handler
import { queue } from 'creek';
await queue.send({ userId: 'abc', action: 'welcome-email' });
```

```ts
// Consumer — export from the Worker entry
export default {
  async queue(batch, env, ctx) {
    for (const msg of batch.messages) {
      console.log(msg.body);
      msg.ack();
    }
  },
};
```

Send a message from the CLI (useful for testing):
```bash
creek queue send '{"userId":"abc"}' --json
```
