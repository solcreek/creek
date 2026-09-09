/**
 * Tenant context resolved by the tenant middleware chain.
 * All downstream modules (projects, deployments, domains) consume this.
 */
export interface TenantContext {
  user: AuthUser;
  teamId: string;
  teamSlug: string;
  // Optional in the type even though tenantMiddleware always sets it on its
  // success path: keeps consumers (e.g. requirePermission) doing an explicit
  // fail-closed `!memberRole` check instead of trusting the type.
  memberRole?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  activeOrganizationId: string | null;
}
