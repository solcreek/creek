import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient } from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import { globalArgs, resolveJsonMode, jsonOutput, AUTH_BREADCRUMBS } from "../utils/output.js";

export const projectsCommand = defineCommand({
  meta: {
    name: "projects",
    description: "List all projects",
  },
  args: { ...globalArgs },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = getToken();

    if (!token) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_authenticated" }, 1, AUTH_BREADCRUMBS);
      consola.error("Not authenticated. Run `creek login` first.");
      process.exit(1);
    }

    const client = new CreekClient(getApiUrl(), token);
    const projects = await client.listProjects();

    if (jsonMode) {
      const crumbs = projects.length > 0
        ? projects.slice(0, 3).map((p) => ({
            command: `creek deployments --project ${p.slug}`,
            description: `List deployments for ${p.slug}`,
          }))
        : [{ command: "creek deploy", description: "Deploy your first project" }];
      jsonOutput({ ok: true, projects }, 0, crumbs);
    }

    if (projects.length === 0) {
      consola.info("No projects yet. Deploy one with `creek deploy`.");
      return;
    }

    consola.info(`${projects.length} project(s)\n`);
    for (const p of projects) {
      const framework = p.framework ? ` (${p.framework})` : "";
      const deployed = p.production_deployment_id ? "deployed" : "not deployed";
      consola.log(`  ${p.slug}${framework} — ${deployed}`);
    }
  },
});
