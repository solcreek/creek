import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient } from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "@solcreek/sdk";
import { globalArgs, resolveJsonMode, jsonOutput, AUTH_BREADCRUMBS, NO_PROJECT_BREADCRUMBS } from "../utils/output.js";

export const deploymentsCommand = defineCommand({
  meta: {
    name: "deployments",
    description: "List recent deployments for the current project",
  },
  args: {
    project: {
      type: "string",
      description: "Project slug (default: from creek.toml)",
      required: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = getToken();

    if (!token) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_authenticated" }, 1, AUTH_BREADCRUMBS);
      consola.error("Not authenticated. Run `creek login` first.");
      process.exit(1);
    }

    // Resolve project slug
    let slug = args.project;
    if (!slug) {
      const configPath = join(process.cwd(), "creek.toml");
      if (!existsSync(configPath)) {
        if (jsonMode) jsonOutput({ ok: false, error: "no_project", message: "No creek.toml found. Use --project <slug> or run from a project directory." }, 1, NO_PROJECT_BREADCRUMBS);
        consola.error("No creek.toml found. Use --project <slug> or run from a project directory.");
        process.exit(1);
      }
      slug = parseConfig(readFileSync(configPath, "utf-8")).project.name;
    }

    const client = new CreekClient(getApiUrl(), token);

    let deployments;
    try {
      deployments = await client.listDeployments(slug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to list deployments";
      if (jsonMode) jsonOutput({ ok: false, error: "api_error", message: msg }, 1);
      consola.error(msg);
      process.exit(1);
    }

    if (jsonMode) {
      const crumbs = deployments.length > 0
        ? [
            { command: `creek rollback --project ${slug}`, description: "Rollback to previous deployment" },
            { command: `creek status`, description: "Check current project status" },
          ]
        : [{ command: `creek deploy`, description: "Create first deployment" }];
      jsonOutput({ ok: true, project: slug, deployments }, 0, crumbs);
    }

    if (deployments.length === 0) {
      consola.info(`No deployments for ${slug}. Run \`creek deploy\` to create one.`);
      return;
    }

    consola.info(`${deployments.length} deployment(s) for ${slug}\n`);
    for (const d of deployments) {
      const status = d.status === "active" ? "\x1b[32mactive\x1b[0m" : d.status;
      const branch = d.branch ? ` (${d.branch})` : "";
      const age = timeAgo(d.created_at);
      consola.log(`  ${d.id.slice(0, 8)}  ${status}  ${age}${branch}`);
    }
  },
});

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
