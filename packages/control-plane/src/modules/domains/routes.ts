import { Hono } from "hono";
import type { Env, AuthUser } from "../../types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { recordAudit } from "../audit/service.js";
import { requirePermission } from "../tenant/permissions.js";
import { resolveProject } from "../tenant/resolve-project.js";
import { validateHostname } from "./validation.js";
import {
  createCustomHostname,
  getCustomHostname,
  deleteCustomHostname,
} from "../resources/cloudflare.js";

type DomainEnv = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
    teamId: string;
    teamSlug: string;
    memberRole?: string;
    auditCtx: AuditRequestContext;
  };
};

const domains = new Hono<DomainEnv>();

// The CNAME target tenants point their DNS at: `cname.` on the tenant zone,
// the CF for SaaS fallback origin (infra: custom-hostnames.tf). It's the same
// target Creek's own domains use, and it follows CREEK_DOMAIN on a self-hosted
// install. Single source of truth for the DNS instruction surfaced by `add`,
// the single-domain GET, and `activate`, so the records are always retrievable
// — not only printed once at add time.
//
// Until 2026-09 the instruction said cname.creek.dev, which sits on the product
// zone rather than the tenant zone. Keep that name resolving for anyone who
// followed it.
function cnameTarget(env: Env): string {
  return `cname.${env.CREEK_DOMAIN || "bycreek.com"}`;
}

// A registrable domain with no subdomain can't hold a plain CNAME. Two labels
// is a heuristic: it misses multi-label suffixes (example.co.uk), which then
// get the subdomain wording.
function isApex(hostname: string): boolean {
  return hostname.split(".").length === 2;
}

export type DnsRecord = {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
  purpose: string;
};

function dnsInstructions(env: Env, hostname: string) {
  const target = cnameTarget(env);
  const route: DnsRecord = {
    type: "CNAME",
    name: hostname,
    value: target,
    purpose: isApex(hostname)
      ? "Routes the domain to Creek. At the apex, set it as your DNS provider's CNAME flattening, ALIAS or ANAME record; a plain CNAME isn't allowed there."
      : "Routes the domain to Creek.",
  };
  return {
    // `cname` predates `records` and is kept for existing clients.
    cname: { name: hostname, target },
    apex: isApex(hostname),
    records: [route],
  };
}

// `add`'s verification block: the routing record, plus CF's optional ownership
// TXT when it returned one (kept as `txt` for existing clients too).
function verificationFor(
  env: Env,
  hostname: string,
  txt: { type: string; name: string; value: string } | null,
) {
  const dns = dnsInstructions(env, hostname);
  if (!txt) return dns;
  const ownership: DnsRecord = {
    type: "TXT",
    name: txt.name,
    value: txt.value,
    purpose: "Optional. Proves ownership before traffic arrives, so validation can finish sooner.",
  };
  return { ...dns, txt, records: [...dns.records, ownership] };
}

// List custom domains for a project
domains.get("/:projectId/domains", requirePermission("project:read"), async (c) => {
  const teamId = c.get("teamId");
  const projectId = c.req.param("projectId");

  const project = await resolveProject(c.env.DB, projectId!, teamId);

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const rows = await c.env.DB.prepare(
    "SELECT * FROM custom_domain WHERE projectId = ? ORDER BY createdAt DESC",
  )
    .bind(project.id)
    .all();

  return c.json(rows.results);
});

// Get a single custom domain (with live CF status refresh)
domains.get("/:projectId/domains/:domainId", requirePermission("project:read"), async (c) => {
  const teamId = c.get("teamId");
  const projectId = c.req.param("projectId");
  const domainId = c.req.param("domainId");

  const project = await resolveProject(c.env.DB, projectId!, teamId);

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  const domain = await c.env.DB.prepare(
    "SELECT * FROM custom_domain WHERE id = ? AND projectId = ?",
  )
    .bind(domainId, project.id)
    .first<{
      id: string;
      hostname: string;
      status: string;
      cfCustomHostnameId: string | null;
    }>();

  if (!domain) {
    return c.json({ error: "not_found", message: "Domain not found" }, 404);
  }

  // Live status refresh from CF if pending
  if (domain.cfCustomHostnameId && domain.status !== "active" && c.env.CLOUDFLARE_ZONE_ID) {
    try {
      const cfStatus = await getCustomHostname(c.env, domain.cfCustomHostnameId);
      if (cfStatus.status === "active" && domain.status !== "active") {
        await c.env.DB.prepare("UPDATE custom_domain SET status = 'active' WHERE id = ?")
          .bind(domain.id)
          .run();
        domain.status = "active";
      }
    } catch {
      // CF API failure — return cached status
    }
  }

  // Always include the DNS instruction so it's retrievable any time, not
  // just in the original `add` response.
  return c.json({ ...domain, dns: dnsInstructions(c.env, domain.hostname) });
});

// Add a custom domain
domains.post("/:projectId/domains", requirePermission("domain:manage"), async (c) => {
  const teamId = c.get("teamId");
  const projectId = c.req.param("projectId");
  const body = await c.req.json<{ hostname: string }>();

  if (!body.hostname) {
    return c.json({ error: "validation", message: "hostname is required" }, 400);
  }

  const hostname = body.hostname.toLowerCase().trim();

  // Validate hostname format and blocklist
  // Platform team (owner role) can use reserved *.creek.dev domains
  const memberRole = c.get("memberRole");
  const skipReservedCheck = memberRole === "owner";
  const validation = validateHostname(hostname, { skipReservedCheck });
  if (!validation.ok) {
    return c.json({ error: "validation", message: validation.message }, 400);
  }

  const project = await resolveProject(c.env.DB, projectId!, teamId);

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  // Idempotent for THIS project: re-adding a hostname already on the project
  // returns the existing record + DNS instructions instead of an error, so
  // `add` is safe to re-run and the CNAME is always retrievable. A hostname
  // owned by a different project is a genuine conflict.
  const existing = await c.env.DB.prepare("SELECT * FROM custom_domain WHERE hostname = ?")
    .bind(hostname)
    .first<{ id: string; projectId: string; status: string }>();

  if (existing) {
    if (existing.projectId === project.id) {
      return c.json(
        { domain: existing, verification: dnsInstructions(c.env, hostname), idempotent: true },
        200,
      );
    }
    return c.json(
      { error: "conflict", message: "Hostname already in use by another project" },
      409,
    );
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // Call CF Custom Hostnames API
  let cfCustomHostnameId: string | null = null;
  let ownershipVerification: { type: string; name: string; value: string } | null = null;
  let initialStatus = "pending";

  if (c.env.CLOUDFLARE_ZONE_ID) {
    try {
      const cfResult = await createCustomHostname(c.env, hostname);
      cfCustomHostnameId = cfResult.id;
      ownershipVerification = cfResult.ownership_verification;

      // If CF immediately activated (same account, CNAME pre-set), mark active
      if (cfResult.status === "active") {
        initialStatus = "active";
      }
    } catch (err) {
      // CF API failed — still create the DB record as pending
      // Log but don't block
      console.error("[domains] CF API error:", err);
    }
  }

  await c.env.DB.prepare(
    "INSERT INTO custom_domain (id, projectId, hostname, status, cfCustomHostnameId, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, project.id, hostname, initialStatus, cfCustomHostnameId, now)
    .run();

  const domain = await c.env.DB.prepare("SELECT * FROM custom_domain WHERE id = ?")
    .bind(id)
    .first();

  await recordAudit(
    c.env.DB,
    c.get("user"),
    c.get("teamId"),
    {
      action: "domain.add",
      resourceType: "domain",
      resourceId: id,
      metadata: { projectId, hostname },
    },
    c.get("auditCtx"),
  );

  return c.json(
    {
      domain,
      // The records to set, unless CF already activated it. Returned even when
      // CF gave no ownership record (e.g. the CF call failed), so the caller
      // always knows where to point DNS.
      verification:
        initialStatus !== "active" ? verificationFor(c.env, hostname, ownershipVerification) : null,
    },
    201,
  );
});

// Activate a custom domain (manual override)
domains.post(
  "/:projectId/domains/:domainId/activate",
  requirePermission("domain:manage"),
  async (c) => {
    const teamId = c.get("teamId");
    const projectId = c.req.param("projectId");
    const domainId = c.req.param("domainId");

    const project = await resolveProject(c.env.DB, projectId!, teamId);

    if (!project) {
      return c.json({ error: "not_found", message: "Project not found" }, 404);
    }

    const domain = await c.env.DB.prepare(
      "SELECT id, hostname, status, cfCustomHostnameId FROM custom_domain WHERE id = ? AND projectId = ?",
    )
      .bind(domainId, project.id)
      .first<{ id: string; hostname: string; status: string; cfCustomHostnameId: string | null }>();

    if (!domain) {
      return c.json({ error: "not_found", message: "Domain not found" }, 404);
    }

    if (domain.status === "active") {
      return c.json({ ok: true, status: "active" });
    }

    const markActive = async () => {
      await c.env.DB.prepare("UPDATE custom_domain SET status = 'active' WHERE id = ?")
        .bind(domain.id)
        .run();
      await recordAudit(
        c.env.DB,
        c.get("user"),
        c.get("teamId"),
        {
          action: "domain.activate",
          resourceType: "domain",
          resourceId: domainId,
          metadata: { projectId },
        },
        c.get("auditCtx"),
      );
    };

    // When the domain is wired through CF, only claim "active" if the edge
    // confirms the hostname. Flipping a domain that doesn't resolve yet to
    // "active" was the misleading part — distinguish it as "pending_dns".
    if (domain.cfCustomHostnameId && c.env.CLOUDFLARE_ZONE_ID) {
      try {
        const cf = await getCustomHostname(c.env, domain.cfCustomHostnameId);
        if (cf.status === "active") {
          await markActive();
          return c.json({ ok: true, status: "active" });
        }
        return c.json({
          ok: false,
          status: "pending_dns",
          message: `Domain not verified yet (edge status: ${cf.status}). Point DNS to ${cnameTarget(c.env)}, then retry.`,
        });
      } catch {
        return c.json({
          ok: false,
          status: "pending_dns",
          message: "Could not verify the domain with the edge yet. Check your DNS and retry.",
        });
      }
    }

    // No CF hostname to verify against (self-hosted / zone not configured):
    // honor activate as an explicit manual override, but label it as such.
    await markActive();
    return c.json({ ok: true, status: "active", manual: true });
  },
);

// Remove a custom domain
domains.delete("/:projectId/domains/:domainId", requirePermission("domain:manage"), async (c) => {
  const teamId = c.get("teamId");
  const projectId = c.req.param("projectId");
  const domainId = c.req.param("domainId");

  const project = await resolveProject(c.env.DB, projectId!, teamId);

  if (!project) {
    return c.json({ error: "not_found", message: "Project not found" }, 404);
  }

  // Get the domain to check for CF custom hostname
  const domain = await c.env.DB.prepare(
    "SELECT id, cfCustomHostnameId FROM custom_domain WHERE id = ? AND projectId = ?",
  )
    .bind(domainId, project.id)
    .first<{ id: string; cfCustomHostnameId: string | null }>();

  if (!domain) {
    return c.json({ error: "not_found", message: "Domain not found" }, 404);
  }

  // Delete from CF if custom hostname exists
  if (domain.cfCustomHostnameId && c.env.CLOUDFLARE_ZONE_ID) {
    try {
      await deleteCustomHostname(c.env, domain.cfCustomHostnameId);
    } catch {
      // CF cleanup failure — still remove from DB
      console.error("[domains] CF delete failed for", domain.cfCustomHostnameId);
    }
  }

  await c.env.DB.prepare("DELETE FROM custom_domain WHERE id = ? AND projectId = ?")
    .bind(domainId, project.id)
    .run();

  await recordAudit(
    c.env.DB,
    c.get("user"),
    c.get("teamId"),
    {
      action: "domain.remove",
      resourceType: "domain",
      resourceId: domainId,
      metadata: { projectId },
    },
    c.get("auditCtx"),
  );

  return c.json({ ok: true });
});

export { domains };
