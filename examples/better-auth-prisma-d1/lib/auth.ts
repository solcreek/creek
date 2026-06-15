import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { PrismaClient } from "@/app/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

// Exactly what a Better Auth + Prisma user writes locally — Creek swaps the
// better-sqlite3 adapter for D1 at build time (zero app-code change).
const adapter = new PrismaBetterSqlite3({ url: "file:./prisma/dev.db" });
export const prisma = new PrismaClient({ adapter });

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  emailAndPassword: { enabled: true },
  // A real app sets BETTER_AUTH_SECRET via `creek env set`; fallback lets the
  // no-env sandbox preview boot for this validation.
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-not-for-prod-0123456789abcdef",
});
