import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient } from "@solcreek/sdk";
import { getToken, getApiUrl, getSandboxApiUrl } from "../utils/config.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig, formatDetectionSummary, type ResolvedConfig, ConfigNotFoundError, parseConfig } from "@solcreek/sdk";
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
    { command: "creek deploy --template landing", description: "Deploy a new sandbox from a template" },
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

  let resolved: ResolvedConfig;
  try {
    resolved = resolveConfig(process.cwd());
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      if (jsonMode) jsonOutput({ ok: false, error: "no_project", message: "No project config found" }, 1, NO_PROJECT_BREADCRUMBS);
      consola.error("No project config found.");
      consola.info("To check a sandbox: creek status <sandboxId>");
      process.exit(1);
    }
    throw err;
  }

  const client = new CreekClient(getApiUrl(), token);

  let project;
  try {
    project = await client.getProject(resolved.projectName);
  } catch {
    if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: `Project "${resolved.projectName}" not found` }, 1, [
      { command: "creek deploy", description: "Deploy to create the project" },
      { command: "creek projects", description: "List existing projects" },
    ]);
    consola.error(`Project "${resolved.projectName}" not found.`);
    process.exit(1);
  }

  if (jsonMode) {
    jsonOutput({
      ok: true,
      type: "project",
      project: project.slug,
      config: resolved.source,
      framework: project.framework,
      productionDeploymentId: project.production_deployment_id,
      bindings: resolved.bindings.map((b) => b.type),
      cron: resolved.cron,
      queue: resolved.queue,
      createdAt: project.created_at,
    }, 0, [
      { command: `creek deployments --project ${project.slug}`, description: "List deployment history" },
      { command: "creek deploy", description: "Deploy a new version" },
    ]);
  }

  const deployed = project.production_deployment_id ? "deployed" : "not deployed";

  consola.log(`\n  Project ${project.slug}`);
  consola.log(`  Config:  ${formatDetectionSummary(resolved)}`);
  consola.log(`  Status:  ${deployed}`);
  if (project.production_deployment_id) {
    consola.log(`  Deploy:  ${project.production_deployment_id.slice(0, 8)}`);
  }
  if (resolved.cron.length > 0) {
    consola.log(`  Cron:    ${resolved.cron.join(", ")}`);
  }
  if (resolved.queue) {
    consola.log("  Queue:   enabled");
  }
  consola.log("");
}
