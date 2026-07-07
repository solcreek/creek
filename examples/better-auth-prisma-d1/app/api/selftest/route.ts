import { auth, prisma } from "@/lib/auth";

const DDL = [
  `CREATE TABLE IF NOT EXISTS "user" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT NOT NULL, "emailVerified" BOOLEAN NOT NULL DEFAULT false, "image" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "session" ("id" TEXT NOT NULL PRIMARY KEY, "expiresAt" DATETIME NOT NULL, "token" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL, "ipAddress" TEXT, "userAgent" TEXT, "userId" TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "account" ("id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "providerId" TEXT NOT NULL, "userId" TEXT NOT NULL, "accessToken" TEXT, "refreshToken" TEXT, "idToken" TEXT, "accessTokenExpiresAt" DATETIME, "refreshTokenExpiresAt" DATETIME, "scope" TEXT, "password" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "verification" ("id" TEXT NOT NULL PRIMARY KEY, "identifier" TEXT NOT NULL, "value" TEXT NOT NULL, "expiresAt" DATETIME NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "user_email_key" ON "user"("email")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "session_token_key" ON "session"("token")`,
];

export async function GET() {
  const steps: Record<string, unknown> = {};
  try {
    for (const stmt of DDL) await prisma.$executeRawUnsafe(stmt);
    const email = `t${Date.now()}@example.com`;
    const password = "test-password-123";

    // WRITE: user + account + session (Better Auth's multi-table create on D1)
    const signUp = await auth.api.signUpEmail({ body: { email, password, name: "Tester" } });
    steps.signUp = {
      userId: (signUp as any)?.user?.id ?? null,
      hasToken: !!(signUp as any)?.token,
    };

    // READ + VERIFY: read account by email, verify password hash, write a session
    const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const setCookie = signIn.headers.get("set-cookie") ?? "";
    steps.signIn = {
      status: signIn.status,
      gotSessionCookie: /better-auth\.session/.test(setCookie),
    };

    // READ session back via the cookie (what a login gate does on every request)
    const session = await auth.api.getSession({ headers: new Headers({ cookie: setCookie }) });
    steps.getSession = {
      hasUser: !!(session as any)?.user,
      email: (session as any)?.user?.email ?? null,
    };

    return Response.json({
      ok: true,
      orm: "better-auth + prisma → D1",
      fullCycle: !!(session as any)?.user,
      users: await prisma.user.count(),
      sessions: await prisma.session.count(),
      steps,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e), steps });
  }
}
