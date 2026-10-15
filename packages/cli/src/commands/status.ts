import { defineCommand } from "citty";
import consola from "consola";
import { CreekApiError, CreekClient } from "@solcreek/sdk";
import { getToken, getApiUrl, getSandboxApiUrl } from "../utils/config.js";
import {
  formatDetectionSummary,
  resolvedConfigToBindingRequirements,
  type ResolvedConfig,
} from "@solcreek/sdk";
import { globalArgs, resolveJsonMode, jsonOutput, AUTH_BREADCRUMBS } from "../utils/output.js";
import {
  projectArg,
  projectBreadcrumbs,
  projectFromDirectory,
  resolveProject,
} from "../utils/command-context.js";
import { findUndeclaredBindings, formatBindingDrift } from "../utils/binding-drift.js";
import { apiErrorFields, apiErrorHints } from "../utils/api-error.js";

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
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);

    // If an ID is provided, check sandbox status (no auth needed)
    if (args.id) {
      return await sandboxStatus(args.id, jsonMode);
    }

    // Otherwise, check the project's status (needs auth + --project or a
    // project config in cwd)
    return await projectStatus(args.project as string | undefined, jsonMode);
  },
});

async function sandboxStatus(sandboxId: string, jsonMode: boolean) {
  const sandboxApiUrl = getSandboxApiUrl();
  const res = await fetch(`${sandboxApiUrl}/api/sandbox/${sandboxId}/status`);

  if (!res.ok) {
    if (jsonMode)
      jsonOutput({ ok: false, error: "not_found", message: "Sandbox not found" }, 1, [
        {
          command: "creek deploy --template landing",
          description: "Deploy a new sandbox from a template",
        },
      ]);
    consola.error("Sandbox not found. It may have expired.");
    process.exit(1);
  }

  const status = (await res.json()) as Record<string, unknown>;

  if (jsonMode) {
    const crumbs = (status as { claimable?: boolean }).claimable
      ? [{ command: `creek claim ${sandboxId}`, description: "Claim as permanent project" }]
      : [{ command: "creek deploy", description: "Deploy a new version" }];
    jsonOutput({ ok: true, type: "sandbox", ...status }, 0, crumbs);
  }

  const s = status.status as string;
  const statusColor =
    s === "active"
      ? `\x1b[32m${s}\x1b[0m`
      : s === "failed"
        ? `\x1b[31m${s}\x1b[0m`
        : s === "expired"
          ? `\x1b[33m${s}\x1b[0m`
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

async function projectStatus(projectArgSlug: string | undefined, jsonMode: boolean) {
  const token = getToken();
  if (!token) {
    if (jsonMode) jsonOutput({ ok: false, error: "not_authenticated" }, 1, AUTH_BREADCRUMBS);
    consola.error("Not authenticated. Run `creek login` first.");
    consola.info("To check a sandbox: creek status <sandboxId>");
    process.exit(1);
  }

  const { slug, source: projectSource } = resolveProject(projectArgSlug, jsonMode);
  // The local config describes the project only when this directory deploys
  // as it; `--project other` from elsewhere reports the server side alone.
  // Compare with the name deploy uses (config.projectName), not the named
  // slug: `status --project web` in a static site deployed as "web" must
  // still show its config. (Without --project, resolveProject has already
  // refused a directory-derived name.)
  let resolved: ResolvedConfig | null = null;
  try {
    const local = projectFromDirectory();
    if (local && local.config.projectName === slug) resolved = local.config;
  } catch {
    // Only reachable with --project: without it, resolveProject has already
    // exited invalid_config on this error. The local config is not the
    // project being asked about, so it is just left out.
  }

  const client = new CreekClient(getApiUrl(), token);

  let project;
  try {
    project = await client.getProject(slug);
  } catch (err) {
    // Only a 404 means the project is missing; a refused key or a failing
    // server must not read as "deploy to create it".
    if (err instanceof CreekApiError && err.status === 404) {
      if (jsonMode)
        jsonOutput(
          {
            ok: false,
            error: "not_found",
            message: `Project "${slug}" not found`,
            ...apiErrorFields(err),
          },
          1,
          projectBreadcrumbs(slug, [
            { command: "creek deploy", description: "Deploy to create the project" },
            { command: "creek projects", description: "List existing projects" },
          ]),
        );
      consola.error(`Project "${slug}" not found.`);
      process.exit(1);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      jsonOutput({ ok: false, error: "api_error", message, ...apiErrorFields(err) }, 1);
    }
    consola.error(message);
    for (const hint of apiErrorHints(err)) consola.info(hint);
    process.exit(1);
  }

  // Resource bindings attached server-side but not in the local config. A
  // provisioned attachment binds at deploy time, but it lives outside the
  // config. Surface them so `creek status` reflects the real attachment state
  // and flags what a fresh clone wouldn't recreate.
  // CF-only: the creekd target resolves no CF bindings (injected at runtime),
  // so the drift concept doesn't apply and every attachment would look
  // undeclared.
  const undeclaredBindings =
    resolved?.target === "cf"
      ? await findUndeclaredBindings(
          client,
          project.slug,
          resolvedConfigToBindingRequirements(resolved).map((b) => b.bindingName),
        )
      : [];

  if (jsonMode) {
    jsonOutput(
      {
        ok: true,
        type: "project",
        project: project.slug,
        projectSource,
        config: resolved?.source ?? null,
        framework: project.framework,
        productionDeploymentId: project.production_deployment_id,
        bindings: resolved ? resolved.bindings.map((b) => b.type) : [],
        undeclaredBindings,
        cron: resolved?.cron ?? [],
        queue: resolved?.queue ?? false,
        createdAt: project.created_at,
      },
      0,
      projectBreadcrumbs(slug, [
        {
          command: `creek deployments --project ${project.slug}`,
          description: "List deployment history",
        },
        { command: "creek deploy", description: "Deploy a new version" },
      ]),
    );
  }

  const deployed = project.production_deployment_id ? "deployed" : "not deployed";

  consola.log(`\n  Project ${project.slug}`);
  if (resolved) consola.log(`  Config:  ${formatDetectionSummary(resolved)}`);
  consola.log(`  Status:  ${deployed}`);
  if (project.production_deployment_id) {
    consola.log(`  Deploy:  ${project.production_deployment_id.slice(0, 8)}`);
  }
  if (resolved && resolved.cron.length > 0) {
    consola.log(`  Cron:    ${resolved.cron.join(", ")}`);
  }
  if (resolved?.queue) {
    consola.log("  Queue:   enabled");
  }
  consola.log("");

  if (undeclaredBindings.length > 0) {
    consola.info(`Attached but not in your config: ${formatBindingDrift(undeclaredBindings)}`);
    consola.info(
      "  Attached server-side, not in your config — a fresh clone wouldn't recreate them. Declare them in config, or detach.",
    );
    consola.log("");
  }
}
