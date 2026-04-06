import { betterAuth } from "better-auth";
import { admin, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";

export const auth = betterAuth({
  database: {
    type: "sqlite",
    url: ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/331daa1bfe584995c9d0416b10f5a4f8628ed3058db8b20ed4eade4294458e72.sqlite",
  },
  emailAndPassword: { enabled: true },
  plugins: [
    admin({ defaultRole: "user" }),
    apiKey({ defaultPrefix: "creek_", enableSessionForAPIKeys: true }),
    organization({
      schema: {
        organization: {
          additionalFields: {
            plan: { type: "string", required: false, defaultValue: "free" },
          },
        },
      },
      allowUserToCreateOrganization: true,
    }),
  ],
});
