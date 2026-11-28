export type AuditAction =
  | "project.create"
  | "project.delete"
  | "deployment.create"
  | "deployment.deploy"
  | "deployment.promote"
  | "deployment.rollback"
  | "domain.add"
  | "domain.activate"
  | "domain.set_primary"
  | "domain.redirect_update"
  | "domain.access_update"
  | "domain.access_remove"
  | "domain.remove"
  | "envvar.set"
  | "envvar.delete"
  | "instant_deploy.create"
  | "instant_deploy.update"
  | "trigger.cron.update"
  | "trigger.queue.update"
  | "api_key.create"
  | "api_key.revoke"
  | "integration.cloudflare.connect"
  | "integration.cloudflare.disconnect";

export type AuditResourceType =
  | "project"
  | "deployment"
  | "domain"
  | "envvar"
  | "instant_deploy"
  | "trigger"
  | "api_key"
  | "integration";

export interface AuditEntry {
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

/** Request-level metadata captured by middleware, stored on Hono context. */
export interface AuditRequestContext {
  ip: string;
  ipHash: string;
  country: string | null;
  userAgent: string | null;
  cfRay: string | null;
}
