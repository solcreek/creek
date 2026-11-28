import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { apiKeyClient } from "@better-auth/api-key/client";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:8787",
  basePath: "/api/auth",
  fetchOptions: {
    credentials: "include",
  },
  plugins: [organizationClient(), apiKeyClient()],
});

export const { useSession, useListOrganizations, useActiveOrganization } = authClient;

export interface Team {
  id: string;
  name: string;
  slug: string;
}

/**
 * The team the API is acting on. A session without an active organization
 * (e.g. right after sign-up) is served the first team the user belongs to
 * (control-plane tenant/resolve.ts), so the dashboard falls back the same way.
 */
export function useCurrentTeam(): { team: Team | null; isPending: boolean } {
  const active = useActiveOrganization();
  const list = useListOrganizations();
  const team = (active.data as Team | null) ?? (list.data as Team[] | null)?.[0] ?? null;
  return { team, isPending: !team && (active.isPending || list.isPending) };
}
