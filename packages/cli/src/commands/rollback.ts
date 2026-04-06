import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient, parseConfig } from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalArgs, resolveJsonMode, jsonOutput, AUTH_BREADCRUMBS } from "../utils/output.js";

function getProjectSlug(args?: { project?: string }): string {
  if (args?.project) return args.project;
  const configPath = join(process.cwd(), "creek.toml");
  if (!existsSync(configPath)) {
    consola.error("No creek.toml found. Use --project <slug> or run from a project directory.");
    process.exit(1);
  }
  return parseConfig(readFileSync(configPath, "utf-8")).project.name;
}

export const rollbackCommand = defineCommand({
  meta: {
    name: "rollback",
    description: "Rollback production to a previous deployment",
  },
  args: {
    deployment: {
      type: "positional",
      description: "Deployment ID to rollback to (default: previous)",
      required: false,
    },
    message: {
      type: "string",
      alias: "m",
      description: "Rollback reason (stored in audit log)",
    },
    project: {
      type: "string",
      description: "Project slug (default: from creek.toml)",
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = getToken();

    if (!token) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_authenticated", message: "Not authenticated" }, 1, AUTH_BREADCRUMBS);
      consola.error("Not authenticated. Run `creek login` first.");
      process.exit(1);
    }

    const projectSlug = getProjectSlug(args as { project?: string });
    const client = new CreekClient(getApiUrl(), token);

    const deploymentId = args.deployment as string | undefined;
    const message = args.message as string | undefined;

    try {
      const result = await client.rollback(projectSlug, {
        deploymentId: deploymentId || undefined,
        message: message || undefined,
      });

      if (jsonMode) {
        jsonOutput(result, 0, [
          { command: `creek status`, description: "Verify rollback status" },
          { command: `creek deployments --project ${projectSlug}`, description: "View deployment history" },
        ]);
        return;
      }

      consola.success(`⬡ Rolled back to deployment ${result.rolledBackTo.slice(0, 8)}`);
      consola.info(`Production URL: ${result.url}`);
      if (message) {
        consola.info(`Reason: ${message}`);
      }
    } catch (err: any) {
      const msg = err.message ?? "Rollback failed";
      if (jsonMode) jsonOutput({ ok: false, error: "rollback_failed", message: msg }, 1, [
        { command: `creek deployments --project ${projectSlug}`, description: "List available deployments" },
      ]);
      consola.error(msg);
      process.exit(1);
    }
  },
});
