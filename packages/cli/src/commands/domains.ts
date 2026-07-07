import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient } from "@solcreek/sdk";
import { globalArgs, resolveJsonMode, jsonOutput } from "../utils/output.js";
import { requireClient, resolveProjectSlug, apiCall } from "../utils/command-context.js";

const projectArg = {
  project: { type: "string" as const, description: "Project slug (default: from creek.toml)" },
};

const domainsLs = defineCommand({
  meta: { name: "ls", description: "List custom domains" },
  args: {
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = requireClient(jsonMode);
    const slug = resolveProjectSlug(args.project, jsonMode);
    const domains = await apiCall(jsonMode, "api_error", () => client.listDomains(slug));

    if (jsonMode) {
      jsonOutput({ ok: true, project: slug, domains }, 0, [
        {
          command: `creek domains add <HOSTNAME> --project ${slug}`,
          description: "Add a custom domain",
        },
      ]);
      return;
    }

    if (domains.length === 0) {
      consola.info("No custom domains configured.");
      return;
    }

    for (const d of domains) {
      const statusIcon =
        d.status === "active"
          ? "\x1b[32m●\x1b[0m"
          : d.status === "pending"
            ? "\x1b[33m○\x1b[0m"
            : d.status === "failed"
              ? "\x1b[31m✕\x1b[0m"
              : "○";
      consola.log(`  ${statusIcon} ${d.hostname}  ${d.status}  (${d.id.slice(0, 8)})`);
    }
  },
});

const domainsAdd = defineCommand({
  meta: { name: "add", description: "Add a custom domain" },
  args: {
    hostname: {
      type: "positional",
      description: "Domain to add (e.g., app.example.com)",
      required: true,
    },
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = requireClient(jsonMode);
    const slug = resolveProjectSlug(args.project, jsonMode);

    const result = await apiCall(jsonMode, "add_failed", () =>
      client.addDomain(slug, args.hostname),
    );
    const { domain, verification, idempotent } = result;

    if (jsonMode) {
      const crumbs =
        domain.status === "active"
          ? [{ command: `creek domains ls --project ${slug}`, description: "List all domains" }]
          : [
              {
                command: `creek domains show ${domain.hostname} --project ${slug}`,
                description: "Retrieve the DNS records to set",
              },
              {
                command: `creek domains activate ${domain.hostname} --project ${slug}`,
                description: "Activate after DNS setup",
              },
            ];
      jsonOutput(
        { ok: true, project: slug, domain, verification, idempotent: idempotent ?? false },
        0,
        crumbs,
      );
      return;
    }

    if (domain.status === "active") {
      consola.success(`Added ${domain.hostname} (active — SSL provisioned)`);
      return;
    }

    const verb = idempotent ? "Already added" : "Added";
    consola.success(`${verb} ${domain.hostname} (status: ${domain.status})`);
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

async function resolveDomain(
  client: CreekClient,
  slug: string,
  hostname: string,
  jsonMode: boolean,
) {
  const domains = await apiCall(jsonMode, "api_error", () => client.listDomains(slug));
  return domains.find((d) => d.hostname === hostname.toLowerCase());
}

/** Emit a structured `not_found` (JSON mode) or human error, then exit 1. */
function domainNotFound(hostname: string, slug: string, jsonMode: boolean): never {
  const message = `Domain "${hostname}" not found.`;
  if (jsonMode) {
    jsonOutput({ ok: false, error: "not_found", hostname, project: slug, message }, 1, [
      { command: `creek domains ls --project ${slug}`, description: "List configured domains" },
    ]);
  }
  consola.error(message);
  process.exit(1);
}

const domainsShow = defineCommand({
  meta: { name: "show", description: "Show a domain's status and the DNS records to set" },
  args: {
    hostname: { type: "positional", description: "Domain to show", required: true },
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = requireClient(jsonMode);
    const slug = resolveProjectSlug(args.project, jsonMode);

    const found = await resolveDomain(client, slug, args.hostname, jsonMode);
    if (!found) domainNotFound(args.hostname, slug, jsonMode);

    // getDomain refreshes status from the edge and always returns the DNS
    // instruction — the records are retrievable here any time, not only in the
    // one-time `add` output.
    const detail = await apiCall(jsonMode, "api_error", () => client.getDomain(slug, found.id));

    if (jsonMode) {
      jsonOutput({ ok: true, project: slug, domain: detail, dns: detail.dns }, 0, [
        {
          command: `creek domains activate ${detail.hostname} --project ${slug}`,
          description: "Activate once DNS resolves",
        },
      ]);
      return;
    }

    consola.info(`${detail.hostname}  (status: ${detail.status})`);
    consola.info("");
    consola.info("  Point your DNS to Creek:");
    consola.info(`    CNAME  ${detail.dns.cname.name}  →  ${detail.dns.cname.target}`);
    consola.info("");
    if (detail.status === "active") {
      consola.info("  This domain is active — SSL is provisioned.");
    } else {
      consola.info(
        `  Once the CNAME resolves, run \`creek domains activate ${detail.hostname} --project ${slug}\`.`,
      );
    }
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
    const client = requireClient(jsonMode);
    const slug = resolveProjectSlug(args.project, jsonMode);

    const domain = await resolveDomain(client, slug, args.hostname, jsonMode);
    if (!domain) domainNotFound(args.hostname, slug, jsonMode);

    await apiCall(jsonMode, "delete_failed", () => client.deleteDomain(slug, domain.id));

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
    const client = requireClient(jsonMode);
    const slug = resolveProjectSlug(args.project, jsonMode);

    const domain = await resolveDomain(client, slug, args.hostname, jsonMode);
    if (!domain) domainNotFound(args.hostname, slug, jsonMode);

    if (domain.status === "active") {
      if (jsonMode) {
        jsonOutput({ ok: true, hostname: domain.hostname, status: "active", project: slug }, 0);
        return;
      }
      consola.info(`${domain.hostname} is already active.`);
      return;
    }

    const result = await apiCall(jsonMode, "activate_failed", () =>
      client.activateDomain(slug, domain.id),
    );

    // Honest activate: only report success when the edge confirms the hostname.
    // pending_dns means DNS isn't resolving yet — surface it as a non-success
    // (exit 1) with the actionable reason, not a misleading "Activated".
    if (result.status === "pending_dns" || result.ok === false) {
      const message =
        result.message ?? "Domain is not verified yet — set the DNS record and retry.";
      const showCrumb = {
        command: `creek domains show ${domain.hostname} --project ${slug}`,
        description: "Retrieve the DNS records to set",
      };
      if (jsonMode) {
        jsonOutput(
          {
            ok: false,
            error: "pending_dns",
            hostname: domain.hostname,
            status: "pending_dns",
            message,
            project: slug,
          },
          1,
          [showCrumb],
        );
        return;
      }
      consola.warn(`${domain.hostname} is not active yet.`);
      consola.info(`  ${message}`);
      consola.info(`  Run \`${showCrumb.command}\` to see the DNS records.`);
      process.exit(1);
    }

    if (jsonMode) {
      jsonOutput(
        {
          ok: true,
          hostname: domain.hostname,
          status: "active",
          manual: result.manual ?? false,
          project: slug,
        },
        0,
        [{ command: `creek domains ls --project ${slug}`, description: "List all domains" }],
      );
      return;
    }

    consola.success(
      result.manual
        ? `Activated ${domain.hostname} (manual override — no edge to verify against)`
        : `Activated ${domain.hostname}`,
    );
  },
});

export const domainsCommand = defineCommand({
  meta: {
    name: "domains",
    description: "Manage custom domains",
  },
  subCommands: {
    ls: domainsLs,
    show: domainsShow,
    add: domainsAdd,
    rm: domainsRm,
    activate: domainsActivate,
  },
});
