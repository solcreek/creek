# Agent Skills for Creek

[Agent Skills](https://agentskills.io/) for [Creek](https://creek.dev) — the deployment platform that reduces Cloudflare's 200+ API primitives to a single command.

```
npx skills add solcreek/skills
```

See [install.md](install.md) for full setup instructions including CLI installation.

## Available skills

| Skill | Description |
|-------|-------------|
| [creek](skills/creek/SKILL.md) | Deploy and manage applications on Creek — init, deploy, status, rollback, env vars, custom domains, and more. |

## Requires

- [Creek CLI](https://www.npmjs.com/package/creek) (`npm install -g creek`)
- An authenticated account for production deploys (`creek login`)

## License

Apache-2.0
