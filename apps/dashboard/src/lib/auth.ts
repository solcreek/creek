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

export const {
  useSession,
  useListOrganizations,
  useActiveOrganization,
} = authClient;
