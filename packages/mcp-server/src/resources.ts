/**
 * Creek skill resources — exposed via MCP `resources/list` + `resources/read`.
 *
 * Why this exists alongside the filesystem skill:
 *   `npx skills add solcreek/creek/skills` installs the filesystem
 *   skill into Claude Code's skill directory. claude.ai + API users,
 *   and any MCP client that doesn't use the filesystem mechanism,
 *   can't load that. Exposing the same content as MCP resources gives
 *   those agents equivalent structured guidance.
 *
 * Content source: skills/creek/references/ at the monorepo root —
 * same files the filesystem skill consumes. Wrangler's Text module
 * loader (configured in wrangler.jsonc) bundles the .md as strings
 * at build time, so there's nothing to sync and no way for the MCP
 * copy to drift from the skill copy.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// @ts-expect-error — wrangler Text loader turns these into string imports
import COMMANDS from "../../../skills/creek/references/commands.md";
// @ts-expect-error
import DEPLOYMENT_MODES from "../../../skills/creek/references/deployment-modes.md";
// @ts-expect-error
import WORKFLOWS from "../../../skills/creek/references/workflows.md";
// @ts-expect-error
import CREEK_TOML from "../../../skills/creek/references/creek-toml.md";
// @ts-expect-error
import DIAGNOSIS from "../../../skills/creek/references/diagnosis.md";
// @ts-expect-error
import OBSERVABILITY from "../../../skills/creek/references/observability.md";
// @ts-expect-error
import RESOURCES from "../../../skills/creek/references/resources.md";
// @ts-expect-error
import GITHUB_SETUP from "../../../skills/creek/references/github-setup.md";

interface SkillResource {
  uri: string;
  name: string;
  description: string;
  content: string;
}

const REFERENCES: SkillResource[] = [
  {
    uri: "creek://skill/commands",
    name: "Creek — Command Reference",
    description:
      "Complete command table for the Creek CLI. JSON output format. Pair with creek://skill/workflows for multi-command flows.",
    content: COMMANDS,
  },
  {
    uri: "creek://skill/deployment-modes",
    name: "Creek — Deployment Modes",
    description:
      "Four ways to invoke creek deploy: authenticated (permanent), sandbox (60-min preview), CI/CD, and remote build via GitHub connection.",
    content: DEPLOYMENT_MODES,
  },
  {
    uri: "creek://skill/workflows",
    name: "Creek — Common Workflows",
    description:
      "Multi-step workflows: first deploy, update and rollback, custom domain setup. Also covers supported frameworks and config detection order.",
    content: WORKFLOWS,
  },
  {
    uri: "creek://skill/creek-toml",
    name: "Creek — creek.toml Reference",
    description:
      "Full creek.toml config reference covering [project], [build], [resources] booleans, [triggers] cron + queue.",
    content: CREEK_TOML,
  },
  {
    uri: "creek://skill/diagnosis",
    name: "Creek — Failure Diagnosis Workflow",
    description:
      "Step-by-step runbook when a user reports deploy failed. creek doctor → deployments list → build log → CK-code to fix mapping → redeploy. Plus error-string troubleshooting table.",
    content: DIAGNOSIS,
  },
  {
    uri: "creek://skill/observability",
    name: "Creek — Observability",
    description:
      "Three log streams explained: runtime logs (creek logs), build logs (creek deployments logs), MCP get_build_log tool. When to use each. Edge-cache caveat for why some requests don't appear.",
    content: OBSERVABILITY,
  },
  {
    uri: "creek://skill/resources",
    name: "Creek — Resources v2 (creek db)",
    description:
      "Team-owned database resources with creek db create / attach / detach / rename / delete. The portable pattern using shared schema + routes with split local.ts/worker.ts boot files.",
    content: RESOURCES,
  },
  {
    uri: "creek://skill/github-setup",
    name: "Creek — GitHub Auto-Deploy Setup",
    description:
      "Installing the Creek Deploy GitHub App and connecting a repository for push-to-deploy and PR previews.",
    content: GITHUB_SETUP,
  },
];

const BY_URI = new Map(REFERENCES.map((r) => [r.uri, r]));

export function registerResources(server: McpServer): void {
  for (const ref of REFERENCES) {
    server.registerResource(
      ref.name,
      ref.uri,
      {
        description: ref.description,
        mimeType: "text/markdown",
      },
      async (uri) => {
        const match = BY_URI.get(uri.href);
        if (!match) {
          return { contents: [] };
        }
        return {
          contents: [
            {
              uri: match.uri,
              mimeType: "text/markdown",
              text: match.content,
            },
          ],
        };
      },
    );
  }
}
