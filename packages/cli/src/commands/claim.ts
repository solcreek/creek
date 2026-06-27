import { defineCommand } from "citty";
import consola from "consola";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CreekClient, parseConfig } from "@solcreek/sdk";
import { getToken, getApiUrl, getSandboxApiUrl } from "../utils/config.js";
import { globalArgs, resolveJsonMode, jsonOutput, AUTH_BREADCRUMBS } from "../utils/output.js";

/**
 * The project name `creek deploy` will use from a local creek.toml, if any.
 * Claiming under this name keeps claim and the subsequent deploy pointed at
 * the same project instead of leaving an orphan reserved under the sandbox id.
 */
export function localProjectName(cwd: string): string | null {
  try {
    const tomlPath = join(cwd, "creek.toml");
    if (!existsSync(tomlPath)) return null;
    return parseConfig(readFileSync(tomlPath, "utf-8")).project.name ?? null;
  } catch {
    return null;
  }
}

/** Coerce an arbitrary name into a valid project slug (`^[a-z0-9-]+$`). */
export function normalizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export const claimCommand = defineCommand({
  meta: {
    name: "claim",
    description: "Claim a sandbox deployment as a permanent project",
  },
  args: {
    sandboxId: {
      type: "positional",
      description: "Sandbox ID to claim (shown after sandbox deploy)",
      required: true,
    },
    name: {
      type: "string",
      description: "Project name to reserve (defaults to creek.toml's [project].name, then the sandbox template/id)",
      required: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = getToken();

    if (!token) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_authenticated", message: "Run `creek login` first" }, 1, AUTH_BREADCRUMBS);
      consola.error("You need to be logged in to claim a sandbox.");
      consola.info("Run `creek login` first, then `creek claim` again.");
      process.exit(1);
    }

    const sandboxId = args.sandboxId;

    // 1. Fetch sandbox info
    consola.start("Looking up sandbox...");
    const sandboxApiUrl = getSandboxApiUrl();
    const statusRes = await fetch(`${sandboxApiUrl}/api/sandbox/${sandboxId}/status`);

    if (!statusRes.ok) {
      consola.error("Sandbox not found. It may have expired.");
      process.exit(1);
    }

    const sandbox = (await statusRes.json()) as {
      sandboxId: string;
      status: string;
      framework: string | null;
      templateId: string | null;
      claimable: boolean;
    };

    if (!sandbox.claimable) {
      const msg = sandbox.status === "expired"
        ? "This sandbox has expired and can no longer be claimed."
        : `Sandbox is in '${sandbox.status}' state and cannot be claimed.`;
      if (jsonMode) jsonOutput({ ok: false, error: "not_claimable", status: sandbox.status, message: msg }, 1, [
        { command: "creek deploy", description: "Deploy your project permanently" },
      ]);
      consola.error(msg);
      if (sandbox.status === "expired") consola.info("Run `creek deploy` to deploy your project permanently.");
      process.exit(1);
    }

    // 2. Create permanent project
    consola.start("Creating permanent project...");
    const client = new CreekClient(getApiUrl(), token);

    // Align the reserved name with what `creek deploy` will use: an explicit
    // --name, else the local creek.toml project name, else the sandbox
    // template/id. Without this, claim reserves "<templateId|sandboxId>" while
    // a later deploy uses creek.toml's name — creating a separate, orphaned
    // project. Normalize to the project-slug charset (^[a-z0-9-]+$) so a
    // user-supplied --name can't fail the server's stricter validation.
    const rawSlug =
      (args.name as string | undefined) ?? localProjectName(process.cwd()) ?? sandbox.templateId ?? sandboxId;
    const slug = normalizeSlug(rawSlug) || sandboxId;
    let project: { id: string; slug: string };

    try {
      const res = await client.createProject({
        slug,
        framework: sandbox.framework as any,
      });
      project = res.project;
    } catch {
      // Slug might conflict, try with sandbox ID suffix
      const res = await client.createProject({
        slug: `${slug}-${sandboxId}`,
        framework: sandbox.framework as any,
      });
      project = res.project;
    }

    consola.success(`Created project: ${project.slug}`);

    // 3. Mark sandbox as claimed
    try {
      await fetch(`${sandboxApiUrl}/api/sandbox/${sandboxId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
    } catch {
      // Best effort — claim status update is non-critical
    }

    if (jsonMode) {
      jsonOutput(
        {
          ok: true,
          sandboxId,
          project: project.slug,
          projectId: project.id,
          // Claim reserves the project name only. It does NOT promote the
          // sandbox deploy: production starts with no deployment, and the
          // sandbox's ephemeral D1 does not transfer. A deploy is required.
          productionDeploymentId: null,
          deployed: false,
          note: `Claim reserved the project only — no deployment was created and sandbox data (its ephemeral D1) does not carry over. Run \`creek deploy\` to create the production deployment, with your local project config name (creek.toml/wrangler.*/package.json) set to "${project.slug}" so it targets this project rather than creating a separate one.`,
        },
        0,
        [
          { command: "creek init", description: "Initialize creek.toml for local development" },
          { command: "creek deploy", description: "Required — claim only reserved the project; this creates the production deployment (sandbox data does not transfer)" },
        ],
      );
    }

    consola.success(`Reserved project: ${project.slug}`);
    consola.info("");
    consola.warn("Claim reserved the project name only — it has no deployment yet, and the sandbox's data (ephemeral D1) does not carry over.");
    consola.info("Run `creek deploy` to create the production deployment:");
    consola.info(`  cd your-project`);
    consola.info(`  creek init`);
    consola.info(`  creek deploy    # creates the production deployment`);
    consola.info("");
    consola.info(`Make sure your local project config name is "${project.slug}" — \`creek deploy\` resolves the name from creek.toml/wrangler.*/package.json and deploys by it; a different name creates a separate project.`);
  },
});
