export interface Env {
  SANDBOX_API_URL: string;
  CONTROL_PLANE_URL: string;
  /** Shared secret for service-to-service auth — sandbox-api trusts X-Forwarded-For only with this */
  INTERNAL_SECRET: string;
}
