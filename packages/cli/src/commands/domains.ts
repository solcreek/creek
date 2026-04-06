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

const projectArg = {
  project: { type: "string" as const, description: "Project slug (default: from creek.toml)" },
};

function getClient(): CreekClient {
  const token = getToken();
  if (!token) {
    consola.error("Not authenticated. Run `creek login` first.");
    process.exit(1);
  }
  return new CreekClient(getApiUrl(), token);
}

const domainsLs = defineCommand({
  meta: { name: "ls", description: "List custom domains" },
  args: {
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = getClient();
    const slug = getProjectSlug(args);
    const domains = await client.listDomains(slug);

    if (jsonMode) {
      jsonOutput({ ok: true, project: slug, domains }, 0, [
        { command: `creek domains add <HOSTNAME> --project ${slug}`, description: "Add a custom domain" },
      ]);
      return;
    }

    if (domains.length === 0) {
      consola.info("No custom domains configured.");
      return;
    }

    for (const d of domains) {
      const statusIcon =
        d.status === "active" ? "\x1b[32m●\x1b[0m" :
        d.status === "pending" ? "\x1b[33m○\x1b[0m" :
        d.status === "failed" ? "\x1b[31m✕\x1b[0m" : "○";
      consola.log(`  ${statusIcon} ${d.hostname}  ${d.status}  (${d.id.slice(0, 8)})`);
    }
  },
});

const domainsAdd = defineCommand({
  meta: { name: "add", description: "Add a custom domain" },
  args: {
    hostname: { type: "positional", description: "Domain to add (e.g., app.example.com)", required: true },
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = getClient();
    const slug = getProjectSlug(args);

    const result = await client.addDomain(slug, args.hostname);
    const { domain, verification } = result;

    if (jsonMode) {
      const crumbs = domain.status === "active"
        ? [{ command: `creek domains ls --project ${slug}`, description: "List all domains" }]
        : [
            { command: `creek domains ls --project ${slug}`, description: "Check domain status" },
            { command: `creek domains activate ${domain.hostname} --project ${slug}`, description: "Activate after DNS setup" },
          ];
      jsonOutput({ ok: true, project: slug, domain, verification }, 0, crumbs);
      return;
    }

    if (domain.status === "active") {
      consola.success(`Added ${domain.hostname} (active — SSL provisioned)`);
      return;
    }

    consola.success(`Added ${domain.hostname} (status: ${domain.status})`);
    consola.info("");
    consola.info("  Point your DNS to Creek:");
    consola.info(`    CNAME  ${domain.hostname}  →  cname.creek.dev`);
    if (verification?.txt) {
      consola.info("");
      consola.info("  Or verify ownership first with a TXT record:");
      consola.info(`    TXT  ${verification.txt.name}  →  ${verification.txt.value}`);
    }
    consola.info("");
    consola.info("  Creek will automatically verify and provision SSL.");
    consola.info(`  Run \`creek domains ls --project ${slug}\` to check status.`);
  },
});

const domainsRm = defineCommand({
  meta: { name: "rm", description: "Remove a custom domain" },
  args: {
    hostname: { type: "positional", description: "Domain to remove", required: true },
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = getClient();
    const slug = getProjectSlug(args);

    // Resolve hostname to domain ID
    const domains = await client.listDomains(slug);
    const domain = domains.find((d) => d.hostname === args.hostname.toLowerCase());
    if (!domain) {
      consola.error(`Domain "${args.hostname}" not found.`);
      process.exit(1);
    }

    await client.deleteDomain(slug, domain.id);

    if (jsonMode) {
      jsonOutput({ ok: true, hostname: domain.hostname, removed: true, project: slug }, 0, [
        { command: `creek domains ls --project ${slug}`, description: "List remaining domains" },
      ]);
      return;
    }

    consola.success(`Removed ${domain.hostname}`);
  },
});

const domainsActivate = defineCommand({
  meta: { name: "activate", description: "Activate a pending custom domain" },
  args: {
    hostname: { type: "positional", description: "Domain to activate", required: true },
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = getClient();
    const slug = getProjectSlug(args);

    // Resolve hostname to domain ID
    const domains = await client.listDomains(slug);
    const domain = domains.find((d) => d.hostname === args.hostname.toLowerCase());
    if (!domain) {
      consola.error(`Domain "${args.hostname}" not found.`);
      process.exit(1);
    }

    if (domain.status === "active") {
      consola.info(`${domain.hostname} is already active.`);
      return;
    }

    await client.activateDomain(slug, domain.id);

    if (jsonMode) {
      jsonOutput({ ok: true, hostname: domain.hostname, status: "active", project: slug }, 0, [
        { command: `creek domains ls --project ${slug}`, description: "List all domains" },
      ]);
      return;
    }

    consola.success(`Activated ${domain.hostname}`);
  },
});

export const domainsCommand = defineCommand({
  meta: {
    name: "domains",
    description: "Manage custom domains",
  },
  subCommands: {
    ls: domainsLs,
    add: domainsAdd,
    rm: domainsRm,
    activate: domainsActivate,
  },
});
