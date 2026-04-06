import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../../types.js";
import * as schema from "../../db/schema.js";

function generateUniqueSlug(name: string, email: string): string {
  const base = (name || email.split("@")[0])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  const suffix = crypto.randomUUID().slice(0, 4);
  return base ? `${base}-${suffix}` : `user-${suffix}`;
}

/**
 * Create a Better Auth instance per-request.
 * D1 is only available from env bindings at request time on Workers.
 */
export function createAuth(env: Env) {
  const db = drizzle(env.DB, { schema });

  return betterAuth({
    appName: "Creek",
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,

    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        organization: schema.organization,
        member: schema.member,
        invitation: schema.invitation,
        apikey: schema.apikey,
      },
    }),

    trustedOrigins: [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:5173",
      "http://localhost:8787",
      `https://app.${env.CREEK_DOMAIN}`,
      `https://${env.CREEK_DOMAIN}`,
      "https://app.creek.dev",
      "https://api.creek.dev",
      "https://creek.dev",
      "https://creek-control-plane.kaik.workers.dev",
    ],

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // MVP: skip email verification
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
    },

    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7,   // 7 days
      updateAge: 60 * 60 * 24,        // refresh after 1 day
      cookieCache: {
        enabled: true,
        maxAge: 300,                   // 5 min cookie cache
      },
    },

    advanced: {
      defaultCookieAttributes: {
        secure: env.BETTER_AUTH_URL.startsWith("https"),
        httpOnly: true,
        sameSite: env.BETTER_AUTH_URL.startsWith("https") ? "none" as const : "lax" as const,
      },
    },

    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            // Auto-create a personal organization for every new user.
            // D1 has no transactions, so no FK violation risk here.
            const slug = generateUniqueSlug(user.name ?? "", user.email);
            const orgId = crypto.randomUUID();
            const memberId = crypto.randomUUID();
            const now = Date.now();

            await env.DB.batch([
              env.DB.prepare(
                `INSERT INTO organization (id, name, slug, plan, createdAt) VALUES (?, ?, ?, 'free', ?)`,
              ).bind(orgId, `${user.name ?? user.email}'s team`, slug, now),
              env.DB.prepare(
                `INSERT INTO member (id, userId, organizationId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)`,
              ).bind(memberId, user.id, orgId, now),
            ]);
          },
        },
      },
    },

    plugins: [
      admin({
        defaultRole: "user",
      }),
      apiKey({
        defaultPrefix: "crk_sk_live_",
        enableSessionForAPIKeys: true,
        startingCharactersConfig: {
          shouldStore: true,
          charactersLength: 16, // prefix + first few chars visible
        },
        rateLimit: {
          enabled: false,
        },
      }),
      organization({
        schema: {
          organization: {
            additionalFields: {
              plan: {
                type: "string",
                required: false,
                defaultValue: "free",
              },
            },
          },
        },
        // Auto-create personal org on signup
        allowUserToCreateOrganization: true,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
