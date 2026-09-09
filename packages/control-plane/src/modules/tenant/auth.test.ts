import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import { createAuth } from "./auth.js";
import type { Env } from "../../types.js";

const BASE = "http://localhost:8787";
const ORIGIN = "http://localhost:5173";

function authEnv(t: LocalTestEnv): Env {
  return {
    ...t.env,
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "gh",
    GITHUB_CLIENT_SECRET: "gh",
    GOOGLE_CLIENT_ID: "gg",
    GOOGLE_CLIENT_SECRET: "gg",
  } as Env;
}

function cookieHeader(res: Response): string {
  return (res.headers.get("set-cookie") ?? "")
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function signUp(auth: ReturnType<typeof createAuth>, email: string) {
  const res = await auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ name: "Test User", email, password: "password123" }),
    }),
  );
  expect(res.status).toBe(200);
  return cookieHeader(res);
}

describe("createAuth (Better Auth on the migrated schema)", () => {
  let t: LocalTestEnv;

  afterEach(() => {
    t?.cleanup();
  });

  it("boots against the drizzle schema and serves sessions", async () => {
    t = createLocalTestEnv({ applyMigrations: true });
    const auth = createAuth(authEnv(t));

    // Better Auth 1.7 validates the schema at initialisation and rejects every
    // request on a mismatch, so a plain 200 here proves the schema lines up.
    const ok = await auth.handler(new Request(`${BASE}/api/auth/ok`));
    expect(ok.status).toBe(200);

    const cookie = await signUp(auth, "alice@example.com");
    const session = await auth.handler(
      new Request(`${BASE}/api/auth/get-session`, { headers: { cookie } }),
    );
    expect((await session.json()).user.email).toBe("alice@example.com");
  });

  it("auto-creates a personal organization with a seconds-based createdAt", async () => {
    t = createLocalTestEnv({ applyMigrations: true });
    const auth = createAuth(authEnv(t));
    const cookie = await signUp(auth, "bob@example.com");

    const res = await auth.handler(
      new Request(`${BASE}/api/auth/organization/list`, { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const orgs = (await res.json()) as { name: string; plan: string; createdAt: string }[];
    expect(orgs).toHaveLength(1);
    expect(orgs[0].plan).toBe("free");

    // Read back through Better Auth (drizzle `timestamp` mode = epoch seconds).
    const createdAt = new Date(orgs[0].createdAt);
    expect(Math.abs(createdAt.getTime() - Date.now())).toBeLessThan(60_000);

    const member = await t.env.DB.prepare(`SELECT role, createdAt FROM member`).first<{
      role: string;
      createdAt: number;
    }>();
    expect(member?.role).toBe("owner");
    expect(member!.createdAt).toBeLessThan(100_000_000_000);
  });

  it("issues API keys that resolve to the user's session", async () => {
    t = createLocalTestEnv({ applyMigrations: true });
    const auth = createAuth(authEnv(t));
    const cookie = await signUp(auth, "carol@example.com");

    const created = await auth.handler(
      new Request(`${BASE}/api/auth/api-key/create`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie },
        body: JSON.stringify({ name: "cli" }),
      }),
    );
    expect(created.status).toBe(200);
    const { key, start } = (await created.json()) as { key: string; start: string };
    expect(key.startsWith("crk_sk_live_")).toBe(true);
    expect(start.startsWith("crk_sk_live_")).toBe(true);

    const viaKey = await auth.handler(
      new Request(`${BASE}/api/auth/get-session`, { headers: { "x-api-key": key } }),
    );
    expect((await viaKey.json()).user.email).toBe("carol@example.com");
  });

  it("migration 0008 normalises millisecond timestamps and is idempotent", async () => {
    t = createLocalTestEnv({ applyMigrations: true });
    const ms = Date.now();
    const sec = Math.floor(ms / 1000);
    await t.env.DB.batch([
      t.env.DB.prepare(
        `INSERT INTO organization (id, name, slug, plan, createdAt) VALUES ('o-ms', 'ms', 'ms', 'free', ?)`,
      ).bind(ms),
      t.env.DB.prepare(
        `INSERT INTO organization (id, name, slug, plan, createdAt) VALUES ('o-s', 's', 's', 'free', ?)`,
      ).bind(sec),
    ]);

    const migration = readFileSync(
      join(__dirname, "../../../drizzle/0008_org_member_timestamps_seconds.sql"),
      "utf8",
    );
    await t.env.DB.exec(migration);
    await t.env.DB.exec(migration);

    const rows = await t.env.DB.prepare(`SELECT id, createdAt FROM organization ORDER BY id`).all<{
      id: string;
      createdAt: number;
    }>();
    expect(rows.results).toEqual([
      { id: "o-ms", createdAt: sec },
      { id: "o-s", createdAt: sec },
    ]);
  });
});
