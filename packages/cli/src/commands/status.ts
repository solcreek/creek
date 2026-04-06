import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient } from "@solcreek/sdk";
import { getToken, getApiUrl, getSandboxApiUrl } from "../utils/config.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "@solcreek/sdk";
import { globalArgs, resolveJsonMode, jsonOutput, AUTH_BREADCRUMBS, NO_PROJECT_BREADCRUMBS } from "../utils/output.js";

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Check deployment or sandbox status",
  },
  args: {
    id: {
      type: "positional",
      description: "Sandbox ID (optional — defaults to current project)",
      required: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);

    // If an ID is provided, check sandbox status (no auth needed)
    if (args.id) {
      return await sandboxStatus(args.id, jsonMode);
    }

    // Otherwise, check current project status (needs auth + creek.toml)
    return await projectStatus(jsonMode);
  },
});

async function sandboxStatus(sandboxId: string, jsonMode: boolean) {
  const sandboxApiUrl = getSandboxApiUrl();
  const res = await fetch(`${sandboxApiUrl}/api/sandbox/${sandboxId}/status`);

  if (!res.ok) {
    if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: "Sandbox not found" }, 1, [
    { command: "creek deploy --demo", description: "Deploy a new sandbox" },
  ]);
    consola.error("Sandbox not found. It may have expired.");
    process.exit(1);
  }

  const status = await res.json() as Record<string, unknown>;

  if (jsonMode) {
    const crumbs = (status as { claimable?: boolean }).claimable
      ? [{ command: `creek claim ${sandboxId}`, description: "Claim as permanent project" }]
      : [{ command: "creek deploy", description: "Deploy a new version" }];
    jsonOutput({ ok: true, type: "sandbox", ...status }, 0, crumbs);
  }

  const s = status.status as string;
  const statusColor = s === "active" ? `\x1b[32m${s}\x1b[0m`
    : s === "failed" ? `\x1b[31m${s}\x1b[0m`
    : s === "expired" ? `\x1b[33m${s}\x1b[0m`
    : s;

  consola.log(`\n  Sandbox ${status.sandboxId}`);
  consola.log(`  Status:   ${statusColor}`);
  consola.log(`  URL:      ${status.previewUrl}`);
  if (status.deployDurationMs) {
    consola.log(`  Duration: ${((status.deployDurationMs as number) / 1000).toFixed(1)}s`);
  }
  if (s === "active") {
    consola.log(`  Expires:  ${status.expiresInSeconds}s remaining`);
    if (status.claimable) {
      consola.log(`  Claim:    creek claim ${status.sandboxId}`);
    }
  }
  if (status.failedStep) {
    consola.log(`  Failed:   ${status.failedStep} — ${status.errorMessage}`);
  }
  consola.log("");
}

async function projectStatus(jsonMode: boolean) {
  const token = getToken();
  if (!token) {
    if (jsonMode) jsonOutput({ ok: false, error: "not_authenticated" }, 1, AUTH_BREADCRUMBS);
    consola.error("Not authenticated. Run `creek login` first.");
    consola.info("To check a sandbox: creek status <sandboxId>");
    process.exit(1);
  }

  const configPath = join(process.cwd(), "creek.toml");
  if (!existsSync(configPath)) {
    if (jsonMode) jsonOutput({ ok: false, error: "no_project", message: "No creek.toml found" }, 1, NO_PROJECT_BREADCRUMBS);
    consola.error("No creek.toml found.");
    consola.info("To check a sandbox: creek status <sandboxId>");
    process.exit(1);
  }

  const config = parseConfig(readFileSync(configPath, "utf-8"));
  const client = new CreekClient(getApiUrl(), token);

  let project;
  try {
    project = await client.getProject(config.project.name);
  } catch {
    if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: `Project "${config.project.name}" not found` }, 1, [
      { command: "creek deploy", description: "Deploy to create the project" },
      { command: "creek projects", description: "List existing projects" },
    ]);
    consola.error(`Project "${config.project.name}" not found.`);
    process.exit(1);
  }

  if (jsonMode) {
    jsonOutput({
      ok: true,
      type: "project",
      project: project.slug,
      framework: project.framework,
      productionDeploymentId: project.production_deployment_id,
      createdAt: project.created_at,
    }, 0, [
      { command: `creek deployments --project ${project.slug}`, description: "List deployment history" },
      { command: "creek deploy", description: "Deploy a new version" },
    ]);
  }

  const deployed = project.production_deployment_id ? "deployed" : "not deployed";
  const framework = project.framework ? ` (${project.framework})` : "";

  consola.log(`\n  Project ${project.slug}${framework}`);
  consola.log(`  Status:  ${deployed}`);
  if (project.production_deployment_id) {
    consola.log(`  Deploy:  ${project.production_deployment_id.slice(0, 8)}`);
  }
  consola.log("");
}
