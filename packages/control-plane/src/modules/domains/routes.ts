import { Hono } from "hono";
import type { Env, AuthUser } from "../../types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { recordAudit } from "../audit/service.js";
import { requirePermission } from "../tenant/permissions.js";
import { resolveProject } from "../tenant/resolve-project.js";
import { validateHostname } from "./validation.js";
import { getCustomHostname, deleteCustomHostname } from "../resources/cloudflare.js";
import { createOrAdoptCustomHostname, linkCustomHostname } from "./edge.js";

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

// The CNAME target tenants point their DNS at. Single source of truth for the
// DNS instruction surfaced by `add`, the single-domain GET, and `activate`, so
// the records are always retrievable — not only printed once at add time.
const CNAME_TARGET = "cname.creek.dev";

function dnsInstructions(hostname: string) {
  return { cname: { name: hostname, target: CNAME_TARGET } };
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
  return c.json({ ...domain, dns: dnsInstructions(domain.hostname) });
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
    .first<{ id: string; projectId: string; status: string; cfCustomHostnameId: string | null }>();

  if (existing) {
    if (existing.projectId === project.id) {
      // A row that never reached the edge (the CF call failed at add time) gets
      // another attempt, so re-running `add` repairs it instead of echoing it.
      let domain: unknown = existing;
      let verification: Record<string, unknown> = dnsInstructions(hostname);
      if (!existing.cfCustomHostnameId && c.env.CLOUDFLARE_ZONE_ID) {
        const cf = await createOrAdoptCustomHostname(c.env, hostname);
        if (cf) {
          await linkCustomHostname(c.env, existing.id, cf);
          domain = await c.env.DB.prepare("SELECT * FROM custom_domain WHERE id = ?")
            .bind(existing.id)
            .first();
          // The repair is the first time the edge answered for this row, so its
          // ownership record has never been shown: return it like a first add.
          if (cf.status !== "active" && cf.ownership_verification) {
            verification = { ...verification, txt: cf.ownership_verification };
          }
        }
      }
      return c.json({ domain, verification, idempotent: true }, 200);
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
  let ownershipVerification: unknown = null;
  let initialStatus = "pending";

  if (c.env.CLOUDFLARE_ZONE_ID) {
    // On failure the row is still created, pending with no edge id; activate,
    // a repeated add and the sync cron all retry it.
    const cf = await createOrAdoptCustomHostname(c.env, hostname);
    if (cf) {
      cfCustomHostnameId = cf.id;
      ownershipVerification = cf.ownership_verification;
      // Same account with the CNAME already in place: CF activates at once.
      if (cf.status === "active") initialStatus = "active";
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
      // Include verification instructions if not auto-activated
      verification:
        initialStatus !== "active" && ownershipVerification
          ? {
              ...dnsInstructions(hostname),
              txt: ownershipVerification,
            }
          : null,
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

    // When the zone is configured, the edge decides. A row that never reached
    // the edge (the CF call failed at add time) is registered now: it is never
    // marked active without a custom hostname behind it, which would route the
    // domain with no certificate.
    if (c.env.CLOUDFLARE_ZONE_ID) {
      let cfId = domain.cfCustomHostnameId;
      if (!cfId) {
        const created = await createOrAdoptCustomHostname(c.env, domain.hostname);
        if (!created) {
          return c.json({
            ok: false,
            status: "pending_edge",
            message: "Could not register the domain with the edge yet. Retry in a minute.",
          });
        }
        await linkCustomHostname(c.env, domain.id, created);
        cfId = created.id;
      }
      try {
        const cf = await getCustomHostname(c.env, cfId);
        if (cf.status === "active") {
          await markActive();
          return c.json({ ok: true, status: "active" });
        }
        return c.json({
          ok: false,
          status: "pending_dns",
          message: `Domain not verified yet (edge status: ${cf.status}). Point DNS to ${CNAME_TARGET}, then retry.`,
        });
      } catch {
        return c.json({
          ok: false,
          status: "pending_dns",
          message: "Could not verify the domain with the edge yet. Check your DNS and retry.",
        });
      }
    }

    // No edge to verify against (self-hosted, zone not configured): honor
    // activate as an explicit manual override, but label it as such.
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
