import { Hono } from "hono";
import type { Env, AuthUser } from "../../types.js";
import type { AuditRequestContext } from "../audit/types.js";
import { recordAudit } from "../audit/service.js";
import { requirePermission } from "../tenant/permissions.js";
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

// List custom domains for a project
domains.get(
  "/:projectId/domains",
  requirePermission("project:read"),
  async (c) => {
    const teamId = c.get("teamId");
    const projectId = c.req.param("projectId");

    const project = await c.env.DB.prepare(
      "SELECT id FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
    )
      .bind(projectId, projectId, teamId)
      .first<{ id: string }>();

    if (!project) {
      return c.json(
        { error: "not_found", message: "Project not found" },
        404,
      );
    }

    const rows = await c.env.DB.prepare(
      "SELECT * FROM custom_domain WHERE projectId = ? ORDER BY createdAt DESC",
    )
      .bind(project.id)
      .all();

    return c.json(rows.results);
  },
);

// Get a single custom domain (with live CF status refresh)
domains.get(
  "/:projectId/domains/:domainId",
  requirePermission("project:read"),
  async (c) => {
    const teamId = c.get("teamId");
    const projectId = c.req.param("projectId");
    const domainId = c.req.param("domainId");

    const project = await c.env.DB.prepare(
      "SELECT id FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
    )
      .bind(projectId, projectId, teamId)
      .first<{ id: string }>();

    if (!project) {
      return c.json(
        { error: "not_found", message: "Project not found" },
        404,
      );
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
      return c.json(
        { error: "not_found", message: "Domain not found" },
        404,
      );
    }

    // Live status refresh from CF if pending
    if (
      domain.cfCustomHostnameId &&
      domain.status !== "active" &&
      c.env.CLOUDFLARE_ZONE_ID
    ) {
      try {
        const cfStatus = await getCustomHostname(
          c.env,
          domain.cfCustomHostnameId,
        );
        if (cfStatus.status === "active" && domain.status !== "active") {
          await c.env.DB.prepare(
            "UPDATE custom_domain SET status = 'active' WHERE id = ?",
          )
            .bind(domain.id)
            .run();
          domain.status = "active";
        }
      } catch {
        // CF API failure — return cached status
      }
    }

    return c.json(domain);
  },
);

// Add a custom domain
domains.post(
  "/:projectId/domains",
  requirePermission("domain:manage"),
  async (c) => {
    const teamId = c.get("teamId");
    const projectId = c.req.param("projectId");
    const body = await c.req.json<{ hostname: string }>();

    if (!body.hostname) {
      return c.json(
        { error: "validation", message: "hostname is required" },
        400,
      );
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

    const project = await c.env.DB.prepare(
      "SELECT id, slug FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
    )
      .bind(projectId, projectId, teamId)
      .first<{ id: string; slug: string }>();

    if (!project) {
      return c.json(
        { error: "not_found", message: "Project not found" },
        404,
      );
    }

    // Check if hostname is already taken
    const existing = await c.env.DB.prepare(
      "SELECT id FROM custom_domain WHERE hostname = ?",
    )
      .bind(hostname)
      .first();

    if (existing) {
      return c.json(
        { error: "conflict", message: "Hostname already in use" },
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

    const domain = await c.env.DB.prepare(
      "SELECT * FROM custom_domain WHERE id = ?",
    )
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
                cname: {
                  name: hostname,
                  target: "cname.creek.dev",
                },
                txt: ownershipVerification,
              }
            : null,
      },
      201,
    );
  },
);

// Activate a custom domain (manual override)
domains.post(
  "/:projectId/domains/:domainId/activate",
  requirePermission("domain:manage"),
  async (c) => {
    const teamId = c.get("teamId");
    const projectId = c.req.param("projectId");
    const domainId = c.req.param("domainId");

    const project = await c.env.DB.prepare(
      "SELECT id FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
    )
      .bind(projectId, projectId, teamId)
      .first<{ id: string }>();

    if (!project) {
      return c.json(
        { error: "not_found", message: "Project not found" },
        404,
      );
    }

    const result = await c.env.DB.prepare(
      "UPDATE custom_domain SET status = 'active' WHERE id = ? AND projectId = ?",
    )
      .bind(domainId, project.id)
      .run();

    if (!result.meta.changes) {
      return c.json(
        { error: "not_found", message: "Domain not found" },
        404,
      );
    }

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

    return c.json({ ok: true });
  },
);

// Remove a custom domain
domains.delete(
  "/:projectId/domains/:domainId",
  requirePermission("domain:manage"),
  async (c) => {
    const teamId = c.get("teamId");
    const projectId = c.req.param("projectId");
    const domainId = c.req.param("domainId");

    const project = await c.env.DB.prepare(
      "SELECT id FROM project WHERE (id = ? OR slug = ?) AND organizationId = ?",
    )
      .bind(projectId, projectId, teamId)
      .first<{ id: string }>();

    if (!project) {
      return c.json(
        { error: "not_found", message: "Project not found" },
        404,
      );
    }

    // Get the domain to check for CF custom hostname
    const domain = await c.env.DB.prepare(
      "SELECT id, cfCustomHostnameId FROM custom_domain WHERE id = ? AND projectId = ?",
    )
      .bind(domainId, project.id)
      .first<{ id: string; cfCustomHostnameId: string | null }>();

    if (!domain) {
      return c.json(
        { error: "not_found", message: "Domain not found" },
        404,
      );
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

    await c.env.DB.prepare(
      "DELETE FROM custom_domain WHERE id = ? AND projectId = ?",
    )
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
  },
);

export { domains };
