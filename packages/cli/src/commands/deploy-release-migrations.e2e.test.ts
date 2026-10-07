/**
 * `[release] migrations = true` end to end through the built CLI (#57): a
 * production deploy puts the project's migrations in the staged bundle, and a
 * migration it can't read stops the deploy before anything is created
 * server-side. Runs against a local stand-in for the control-plane API that
 * records every request.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

let server: Server;
let base = "";
let requests: Array<{ method: string; path: string; body: string }> = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const p = new URL(req.url ?? "/", base).pathname;
    requests.push({ method: req.method ?? "", path: p, body });
    const json = (data: unknown, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (p === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>ok</title>");
    }
    if (p === "/api/auth/get-session") {
      return json({ user: { id: "u1", email: "t@example.com", name: "T" }, session: {} });
    }
    if (req.method === "GET" && /^\/projects\/[^/]+$/.test(p)) {
      return json({ id: "p1", slug: "app", organizationId: "o1", productionBranch: "main" });
    }
    if (req.method === "POST" && p.endsWith("/deployments")) {
      // A Turbo request (it carries the commit) always hits the build cache.
      const cacheHit = body.includes("commitSha");
      return json({ deployment: { id: "d1", version: 1, status: "pending" }, cacheHit }, 201);
    }
    if (req.method === "GET" && p.endsWith("/deployments/d1")) {
      return json({ deployment: { id: "d1", status: "active", version: 1 }, url: `${base}/` });
    }
    return json({ ok: true });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

let app: string;
let home: string;

beforeEach(() => {
  requests = [];
  app = mkdtempSync(join(tmpdir(), "creek-release-migrations-app-"));
  home = mkdtempSync(join(tmpdir(), "creek-release-migrations-home-"));
  mkdirSync(join(app, "dist"));
  writeFileSync(join(app, "dist/index.html"), "<!doctype html><title>ok</title>");
  writeFileSync(
    join(app, "creek.toml"),
    '[project]\nname = "app"\n\n[build]\noutput = "dist"\n\n[resources]\ndatabase = true\n\n[release]\nmigrations = true\n',
  );
  mkdirSync(join(app, "db/migrations"), { recursive: true });
  writeFileSync(join(app, "db/migrations/0001_users.sql"), "CREATE TABLE users (id INTEGER);");
  writeFileSync(join(app, "db/migrations/0002_posts.sql"), "CREATE TABLE posts (id INTEGER);");
});

afterEach(() => {
  rmSync(app, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** The environment a user's shell would have (see deploy-json-stdout.e2e). */
function userEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST") || key === "NODE_ENV" || key === "TEST" || key === "CI") {
      delete env[key];
    }
  }
  return env;
}

function deploy(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, "deploy", "--prod", "--skip-build", "--json"], {
      cwd: app,
      env: {
        ...userEnv(),
        HOME: home,
        CREEK_API_URL: base,
        CREEK_SANDBOX_API_URL: base,
        CREEK_TOKEN: "test-token",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`creek deploy timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

describe.skipIf(!existsSync(CLI))("creek deploy with [release] migrations (#57)", () => {
  test("stages the migrations in the production bundle", async () => {
    const r = await deploy();

    expect(r.code, r.stderr).toBe(0);
    const staged = requests.find((q) => q.method === "PUT" && q.path.endsWith("/bundle"));
    expect(staged).toBeDefined();
    const bundle = JSON.parse(staged!.body) as Record<string, unknown>;
    expect(bundle.releaseMigrations).toBe(true);
    expect(bundle.migrations).toEqual([
      { name: "0001_users.sql", statements: ["CREATE TABLE users (id INTEGER);"] },
      { name: "0002_posts.sql", statements: ["CREATE TABLE posts (id INTEGER);"] },
    ]);
  });

  describe("with a clean git checkout the build cache would serve", () => {
    beforeEach(() => {
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: app,
          stdio: "pipe",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@example.com",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@example.com",
          },
        });
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-qm", "init");
    });

    const turboRequests = () =>
      requests.filter((q) => q.method === "POST" && q.body.includes("commitSha"));
    const bundlePuts = () =>
      requests.filter((q) => q.method === "PUT" && q.path.endsWith("/bundle"));

    test("control: without [release] migrations the deploy is served from the cache", async () => {
      writeFileSync(
        join(app, "creek.toml"),
        '[project]\nname = "app"\n\n[build]\noutput = "dist"\n\n[resources]\ndatabase = true\n',
      );
      execFileSync("git", ["commit", "-qam", "off"], {
        cwd: app,
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });

      const r = await deploy();

      expect(r.code, r.stderr).toBe(0);
      expect(turboRequests()).toHaveLength(1);
      expect(bundlePuts()).toEqual([]);
    });

    test("with [release] migrations the cache is skipped and the bundle staged", async () => {
      const r = await deploy();

      expect(r.code, r.stderr).toBe(0);
      expect(turboRequests()).toEqual([]);
      expect(bundlePuts()).toHaveLength(1);
      expect(JSON.parse(bundlePuts()[0].body)).toMatchObject({ releaseMigrations: true });
    });
  });

  test("an unreadable migration stops the deploy before anything is created", async () => {
    mkdirSync(join(app, "db/migrations/0003_unreadable.sql"));

    const r = await deploy();

    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: "migration_unreadable",
      message: expect.stringContaining("0003_unreadable.sql"),
    });
    expect(requests.filter((q) => q.method !== "GET")).toEqual([]);
  });
});
