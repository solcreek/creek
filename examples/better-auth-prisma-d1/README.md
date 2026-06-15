# Better Auth + Prisma on Cloudflare D1

A Next.js app using [Better Auth](https://better-auth.com) for email/password
login, backed by **Prisma 7** with the `better-sqlite3` driver adapter — the
exact stack you'd write for local development. Deployed with Creek, it runs on
**Cloudflare D1** with **no app-code change**: the adapter swaps the local
SQLite driver for D1 at build time, so both your queries _and_ Better Auth's
session/user storage run on D1.

## Why this example exists

Better Auth stores users, sessions, and accounts through the same Prisma client
your app uses. The open question was whether that whole flow survives on D1
(which has limited transaction support). It does — verified end-to-end on a
Creek sandbox: `signUp → signIn → getSession` all round-trip through Prisma → D1.

## The stack (nothing Creek-specific in the code)

- `lib/auth.ts` — `betterAuth({ database: prismaAdapter(prisma, …) })`, where
  `prisma` is a `PrismaClient` constructed with `@prisma/adapter-better-sqlite3`.
- `app/api/auth/[...all]/route.ts` — the Better Auth handler.
- `app/page.tsx` — minimal sign-up / sign-in / sign-out UI (`better-auth/react`).
- `prisma/schema.prisma` — Better Auth's `user` / `session` / `account` /
  `verification` models. `prisma/migrations/` is the schema for D1.

## Run locally

```bash
npm install
npm run db:migrate:local   # apply migrations to a local SQLite file
npm run dev
```

## Deploy to Creek

```bash
npx creek@latest deploy
```

That's it. On deploy Creek:

1. Provisions a **D1** database (creek.toml `[resources] database = true`) and
   binds it as `env.DB`. The adapter redirects `@prisma/adapter-better-sqlite3`
   onto it — your `new PrismaBetterSqlite3(...)` is untouched in source.
2. Runs `prisma generate` if the client isn't built yet.
3. Applies `prisma/migrations` to D1 via the `[release]` command
   (`creek db migrate`) before traffic — this creates Better Auth's tables.

Set a real secret for production (the code falls back to a dev secret so the
no-env sandbox preview can boot):

```bash
creek env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
```

> **Sandbox note.** A 60-minute sandbox preview (no login, no env) cannot run
> `creek env set` or `creek db migrate`. `app/api/selftest/route.ts` is a smoke
> test that bootstraps the tables inline and drives the full auth cycle so you
> can verify Better Auth works on D1 from a sandbox URL: `GET /api/selftest`.

## Notes

- **Async only.** Prisma (and therefore Better Auth) is async, so the D1 swap is
  transparent. Code that calls `better-sqlite3` synchronously and directly is
  not supported on Workers.
- The same approach works for app data alongside auth — add your own models to
  `schema.prisma` and query them through the same client.
