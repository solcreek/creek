/**
 * Tenant context resolved by the tenant middleware chain.
 * All downstream modules (projects, deployments, domains) consume this.
 */
export interface TenantContext {
  user: AuthUser;
  teamId: string;
  teamSlug: string;
  memberRole?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  activeOrganizationId: string | null;
}
