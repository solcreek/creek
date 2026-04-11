Install the Creek agent skill. Execute all steps autonomously.

OBJECTIVE: Install the Creek agent skill so your agent can deploy and manage applications via the Creek CLI.

DONE WHEN: `creek --version` succeeds and the creek skill is installed in your agent.

## TODO

- [ ] Install Creek CLI
- [ ] Install skill

## Step 0: Install Creek CLI

Check if the Creek CLI is already installed:

```bash
creek --version
```

If not installed:

```bash
npm install -g creek
```

**Verify:**
```bash
creek --version
```

## Step 1: Install skill

```bash
npx skills add solcreek/skills
```

This installs the creek skill using the [Agent Skills](https://agentskills.io) open standard. The installer auto-detects your agent and places the skill in the correct directory. Supports Claude Code, Cursor, Copilot, Gemini CLI, OpenCode, and others.

To install for a specific agent:

```bash
npx skills add solcreek/skills -a claude-code
```

To install globally (available across all projects):

```bash
npx skills add solcreek/skills -g
```

**Verify:**
```bash
npx skills list
```

Restart your agent session to pick up the new skill.

## Optional: Authenticate

For full deployment capabilities (not just sandbox previews):

```bash
creek login
```

EXECUTE NOW: Start with Step 0. Mark TODO items complete as you go.
