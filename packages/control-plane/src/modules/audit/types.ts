export type AuditAction =
  | "project.create"
  | "project.delete"
  | "deployment.create"
  | "deployment.deploy"
  | "deployment.promote"
  | "deployment.rollback"
  | "domain.add"
  | "domain.activate"
  | "domain.remove"
  | "envvar.set"
  | "envvar.delete"
  | "instant_deploy.create"
  | "instant_deploy.update";

export type AuditResourceType =
  | "project"
  | "deployment"
  | "domain"
  | "envvar"
  | "instant_deploy";

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
