import { defineCommand } from "citty";
import consola from "consola";
import { CreekApiError, CreekClient } from "@solcreek/sdk";
import { globalArgs, resolveJsonMode, jsonOutput } from "../utils/output.js";
import { requireClient, resolveProject, apiCall, projectArg } from "../utils/command-context.js";
import { dryRunArg, emitDryRunPlan, isDryRun } from "../utils/dry-run.js";

const domainsLs = defineCommand({
  meta: { name: "ls", destructive: false, description: "List custom domains" },
  args: {
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = requireClient(jsonMode);
    const { slug, source: projectSource } = resolveProject(args.project, jsonMode);
    const domains = await apiCall(jsonMode, "api_error", () => client.listDomains(slug));

    if (jsonMode) {
      jsonOutput({ ok: true, project: slug, projectSource, domains }, 0, [
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
  meta: { name: "add", destructive: false, description: "Add a custom domain" },
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
    const { slug, source: projectSource } = resolveProject(args.project, jsonMode);

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
        {
          ok: true,
          project: slug,
          projectSource,
          domain,
          verification,
          idempotent: idempotent ?? false,
        },
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
    consola.info("  Set these DNS records:");
    // The API's records; an older API only sent `cname` (+ `txt`).
    const records =
      verification?.records ??
      [
        verification?.cname && {
          type: "CNAME",
          name: verification.cname.name,
          value: verification.cname.target,
          purpose: "Routes the domain to Creek.",
        },
        verification?.txt && {
          type: "TXT",
          name: verification.txt.name,
          value: verification.txt.value,
          purpose: "Optional. Proves ownership before traffic arrives.",
        },
      ].filter((r): r is NonNullable<typeof r> => Boolean(r));
    for (const record of records) {
      consola.info(`    ${record.type.padEnd(5)}  ${record.name}  →  ${record.value}`);
      consola.info(`           ${record.purpose}`);
    }
    consola.info("");
    consola.info("  Creek will automatically verify and provision SSL.");
    consola.info(`  Run \`creek domains ls --project ${slug}\` to check status.`);
  },
});

/**
 * A hostname as the API stores it (trimmed, lowercased). Every lookup and
 * the already-absent check use this one form, so a padded or mixed-case
 * argument can't miss a listed domain and then read as already removed.
 */
function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}

async function resolveDomain(
  client: CreekClient,
  slug: string,
  hostname: string,
  jsonMode: boolean,
) {
  const domains = await apiCall(jsonMode, "api_error", () => client.listDomains(slug));
  const wanted = normalizeHostname(hostname);
  return domains.find((d) => d.hostname === wanted);
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
  meta: {
    name: "show",
    destructive: false,
    description: "Show a domain's status and the DNS records to set",
  },
  args: {
    hostname: { type: "positional", description: "Domain to show", required: true },
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = requireClient(jsonMode);
    const { slug, source: projectSource } = resolveProject(args.project, jsonMode);

    const found = await resolveDomain(client, slug, args.hostname, jsonMode);
    if (!found) domainNotFound(args.hostname, slug, jsonMode);

    // getDomain refreshes status from the edge and always returns the DNS
    // instruction — the records are retrievable here any time, not only in the
    // one-time `add` output.
    const detail = await apiCall(jsonMode, "api_error", () => client.getDomain(slug, found.id));

    if (jsonMode) {
      jsonOutput({ ok: true, project: slug, projectSource, domain: detail, dns: detail.dns }, 0, [
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

// The API's own hostname shape (control-plane domains/validation.ts): a
// hostname that doesn't match it can never have been added.
const HOSTNAME_SHAPE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * `domains rm` of a hostname the project doesn't have succeeds with
 * `alreadyAbsent: true`, so a re-run converges. Removed domains leave no
 * record, so one removed earlier and one never added can't be told apart —
 * except a string that isn't a hostname at all (a URL, a name with no dot),
 * which is still `not_found`.
 */
function domainAlreadyAbsent(
  hostname: string,
  slug: string,
  projectSource: string,
  jsonMode: boolean,
  dryRun: boolean,
): void {
  const normalized = normalizeHostname(hostname);
  if (!HOSTNAME_SHAPE.test(normalized)) {
    const message = `"${hostname}" is not a hostname (e.g. app.example.com), so it was never a domain of ${slug}.`;
    if (jsonMode) {
      jsonOutput({ ok: false, error: "not_found", hostname, project: slug, message }, 1, [
        { command: `creek domains ls --project ${slug}`, description: "List configured domains" },
      ]);
    }
    consola.error(message);
    process.exit(1);
  }
  const lsCrumb = {
    command: `creek domains ls --project ${slug} --json`,
    description: "List configured domains",
  };
  if (dryRun) {
    emitDryRunPlan(jsonMode, {
      command: `creek domains rm ${normalized}`,
      wouldExecute: false,
      alreadyAbsent: true,
      project: slug,
      projectSource,
      hostname: normalized,
      sideEffects: [`${normalized} is not a domain of ${slug} — nothing to remove`],
      nextStep: lsCrumb.command,
    });
    return;
  }
  const message = `${normalized} is not a domain of ${slug}; nothing was removed. If you expected it, check the name with \`creek domains ls --project ${slug}\`.`;
  if (jsonMode) {
    jsonOutput(
      {
        ok: true,
        hostname: normalized,
        alreadyAbsent: true,
        removed: false,
        project: slug,
        projectSource,
        message,
      },
      0,
      [lsCrumb],
    );
  }
  consola.success(message);
}

const domainsRm = defineCommand({
  meta: { name: "rm", destructive: true, description: "Remove a custom domain" },
  args: {
    hostname: { type: "positional", description: "Domain to remove", required: true },
    ...projectArg,
    ...dryRunArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = requireClient(jsonMode);
    const { slug, source: projectSource } = resolveProject(args.project, jsonMode);

    const domain = await resolveDomain(client, slug, args.hostname, jsonMode);
    if (!domain) {
      domainAlreadyAbsent(args.hostname, slug, projectSource, jsonMode, isDryRun(args));
      return;
    }

    if (isDryRun(args)) {
      emitDryRunPlan(jsonMode, {
        command: `creek domains rm ${domain.hostname}`,
        wouldExecute: true,
        alreadyAbsent: false,
        project: slug,
        projectSource,
        hostname: domain.hostname,
        domainId: domain.id,
        status: domain.status,
        sideEffects: [
          `Remove the project domain record for ${domain.hostname}`,
          "Cloudflare custom-hostname cleanup is attempted only when a CF hostname ID and CLOUDFLARE_ZONE_ID are present; the project record is still removed if that cleanup fails",
        ],
        nextStep: `creek domains rm ${domain.hostname} --project ${slug} --json`,
      });
      return;
    }

    const gone = await apiCall(jsonMode, "delete_failed", () =>
      client.deleteDomain(slug, domain.id).then(
        () => false,
        async (err: unknown) => {
          // Listed a moment ago, 404 now: a concurrent removal got there first
          // only if the project's list loads without this domain. Anything
          // else (the project gone, the list failing) stays an error.
          if (err instanceof CreekApiError && err.status === 404) {
            const after = await client.listDomains(slug).catch(() => null);
            if (after && !after.some((d) => d.id === domain.id)) return true;
          }
          throw err;
        },
      ),
    );
    if (gone) {
      domainAlreadyAbsent(domain.hostname, slug, projectSource, jsonMode, false);
      return;
    }

    if (jsonMode) {
      jsonOutput(
        {
          ok: true,
          hostname: domain.hostname,
          alreadyAbsent: false,
          removed: true,
          project: slug,
          projectSource,
        },
        0,
        [{ command: `creek domains ls --project ${slug}`, description: "List remaining domains" }],
      );
      return;
    }

    consola.success(`Removed ${domain.hostname}`);
  },
});

const domainsActivate = defineCommand({
  meta: { name: "activate", destructive: false, description: "Activate a pending custom domain" },
  args: {
    hostname: { type: "positional", description: "Domain to activate", required: true },
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = requireClient(jsonMode);
    const { slug, source: projectSource } = resolveProject(args.project, jsonMode);

    const domain = await resolveDomain(client, slug, args.hostname, jsonMode);
    if (!domain) domainNotFound(args.hostname, slug, jsonMode);

    if (domain.status === "active") {
      if (jsonMode) {
        jsonOutput(
          { ok: true, hostname: domain.hostname, status: "active", project: slug, projectSource },
          0,
        );
        return;
      }
      consola.info(`${domain.hostname} is already active.`);
      return;
    }

    const result = await apiCall(jsonMode, "activate_failed", () =>
      client.activateDomain(slug, domain.id),
    );

    // Honest activate: only report success when the edge confirms the hostname.
    // pending_dns means DNS isn't resolving yet; pending_edge means the domain
    // couldn't be registered with the edge yet. Either is a non-success (exit 1)
    // with the actionable reason, not a misleading "Activated".
    if (result.status === "pending_dns" || result.ok === false) {
      const status = result.status ?? "pending_dns";
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
            error: status,
            hostname: domain.hostname,
            status,
            message,
            project: slug,
            projectSource,
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
          projectSource,
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
