import { defineCommand } from "citty";
import consola from "consola";
import { CreekApiError } from "@solcreek/sdk";
import { globalArgs, resolveJsonMode, jsonOutput, shouldAutoConfirm, isTTY } from "../utils/output.js";
import { requireClient, apiCall } from "../utils/command-context.js";

const projectsList = defineCommand({
  meta: { name: "list", description: "List all projects" },
  args: { ...globalArgs },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = requireClient(jsonMode);
    const projects = await apiCall(jsonMode, "api_error", () => client.listProjects());

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

const projectsDelete = defineCommand({
  meta: { name: "delete", description: "Delete a project (by slug or id). Does not delete its team-owned databases/buckets." },
  args: {
    slug: { type: "positional", description: "Project slug or id to delete", required: true },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = requireClient(jsonMode);
    const slug = args.slug as string;

    // Destructive + outward-facing: confirm in an interactive run unless
    // --yes. Non-TTY (agents/CI) auto-confirms, consistent with the rest
    // of the CLI's shouldAutoConfirm contract.
    if (!shouldAutoConfirm(args) && isTTY) {
      const ok = (await consola.prompt(`Delete project "${slug}"? This cannot be undone.`, { type: "confirm" })) as unknown as boolean;
      if (!ok) {
        consola.info("Cancelled.");
        process.exit(0);
      }
    }

    try {
      await client.deleteProject(slug);
    } catch (err) {
      if (err instanceof CreekApiError && err.status === 404) {
        const msg = `No project "${slug}" in your team (already deleted, or wrong slug).`;
        if (jsonMode) jsonOutput({ ok: false, error: "not_found", project: slug, message: msg }, 1);
        consola.error(msg);
        process.exit(1);
      }
      const msg = err instanceof Error ? err.message : "Failed to delete project";
      if (jsonMode) jsonOutput({ ok: false, error: "delete_failed", project: slug, message: msg }, 1);
      consola.error(msg);
      process.exit(1);
    }

    if (jsonMode) jsonOutput({ ok: true, project: slug, deleted: true }, 0, [
      { command: "creek projects", description: "List remaining projects" },
    ]);
    consola.success(`Deleted project ${slug}`);
    consola.info("Note: its databases/buckets are team-owned and were not deleted — manage them with `creek db`/`creek storage`.");
  },
});

const SUBCOMMANDS = {
  list: projectsList,
  delete: projectsDelete,
};

export const projectsCommand = defineCommand({
  meta: {
    name: "projects",
    description: "List and manage projects",
  },
  subCommands: SUBCOMMANDS,
  args: { ...globalArgs },
  // Bare `creek projects` keeps listing. citty 0.1.6 runs this parent
  // handler even after a subcommand dispatched, so guard against
  // double-running: only list when no known verb was given.
  run(ctx) {
    const rawArgs = ((ctx as { rawArgs?: string[] }).rawArgs ?? []);
    const verb = rawArgs.find((a) => !a.startsWith("-"));
    if (verb && verb in SUBCOMMANDS) return;
    return projectsList.run!(ctx as Parameters<NonNullable<typeof projectsList.run>>[0]);
  },
});
