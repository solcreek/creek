import { createMiddleware } from "hono/factory";
import type { AuditRequestContext } from "./types.js";
import { hashIp } from "./service.js";

/**
 * Middleware that captures request metadata for audit logging.
 * Must run AFTER tenantMiddleware (needs user context).
 * Stores AuditRequestContext on c.get("auditCtx").
 */
export const auditContextMiddleware = createMiddleware(async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const salt = (c.env as any).IP_HASH_SALT ?? "creek-audit-salt";
  const ipHashed = await hashIp(ip, salt);

  const auditCtx: AuditRequestContext = {
    ip,
    ipHash: ipHashed,
    country: c.req.header("cf-ipcountry") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    cfRay: c.req.header("cf-ray") ?? null,
  };

  c.set("auditCtx", auditCtx);
  return next();
});
