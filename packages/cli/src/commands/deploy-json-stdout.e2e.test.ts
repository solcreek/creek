/**
 * `creek deploy --json` must put exactly one JSON document on stdout
 * (solcreek/creek#62). Agents, CI and pipes parse stdout; JSON mode also
 * switches on by itself whenever stdout isn't a TTY.
 *
 * Unit tests can't catch this: a build command's child process writes to file
 * descriptor 1 directly, bypassing anything mocked inside the test process.
 * So this runs the built CLI as a real subprocess against a local stand-in for
 * the sandbox and control-plane APIs, with a build that prints to stdout, to
 * stderr, and through its own child process, and a fresh HOME so the Terms of
 * Service notice is shown. Each source that leaked before is asserted to land
 * on stderr instead.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

let server: Server;
let base = "";
// Bodies of the build logs the CLI uploads (POST /builds/:id/logs).
let buildLogs: string[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? "/", base);
    const p = url.pathname;
    if (req.method === "POST" && /^\/builds\/[^/]+\/logs$/.test(p)) buildLogs.push(body);
    const json = (body: unknown, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    if (p === "/") {
      // The "deployed site": the CLI's post-deploy check fetches it.
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>ok</title>");
    }
    if (p === "/api/sandbox/deploy") {
      return json({
        sandboxId: "sb1",
        status: "queued",
        statusUrl: `${base}/api/sandbox/sb1/status`,
        previewUrl: `${base}/`,
        expiresAt,
      });
    }
    if (p === "/api/sandbox/sb1/status") {
      return json({
        sandboxId: "sb1",
        status: "active",
        previewUrl: `${base}/`,
        expiresAt,
        expiresInSeconds: 3600,
        claimable: true,
      });
    }
    if (p === "/api/auth/get-session") {
      return json({ user: { id: "u1", email: "t@example.com", name: "T" }, session: {} });
    }
    if (req.method === "GET" && /^\/projects\/[^/]+$/.test(p)) {
      return json({ id: "p1", slug: "app", organizationId: "o1", productionBranch: "main" });
    }
    if (req.method === "POST" && p.endsWith("/deployments")) {
      return json({ deployment: { id: "d1", version: 1, status: "pending" } }, 201);
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
  buildLogs = [];
  app = mkdtempSync(join(tmpdir(), "creek-json-stdout-"));
  home = mkdtempSync(join(tmpdir(), "creek-json-home-"));
  mkdirSync(join(app, "dist"));
  writeFileSync(join(app, "dist/index.html"), "<!doctype html><title>ok</title>");
  writeFileSync(
    join(app, "dist/_worker.mjs"),
    "export default { fetch() { return new Response('w'); } };",
  );
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: "app", private: true, scripts: { build: "node build.mjs" } }),
  );
  // Prints on stdout, on stderr, and through a child process of its own.
  writeFileSync(
    join(app, "build.mjs"),
    [
      'import { execSync } from "node:child_process";',
      'console.log("LEAK-BUILD-STDOUT");',
      'console.error("BUILD-STDERR");',
      'execSync(`node -e "process.stdout.write(\'LEAK-GRANDCHILD\\\\n\')"`, { stdio: "inherit" });',
      "if (process.env.FAIL_BUILD) process.exit(3);",
    ].join("\n"),
  );
  writeFileSync(
    join(app, "creek.toml"),
    '[project]\nname = "app"\n\n[build]\ncommand = "npm run build"\noutput = "dist"\nworker = "dist/_worker.mjs"\n',
  );
});

afterEach(() => {
  rmSync(app, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/**
 * The environment a user's shell would have. vitest exports NODE_ENV=test and
 * VITEST*; inherited, they make consola in the CLI silence info/log output, so
 * the very lines that leak (consola progress, the Terms notice) would never be
 * printed and the test would pass for the wrong reason.
 */
function userEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST") || key === "NODE_ENV" || key === "TEST" || key === "CI") {
      delete env[key];
    }
  }
  return env;
}

/**
 * Run the CLI. Async on purpose: spawnSync would block this process's event
 * loop, and with it the stand-in API server the CLI is talking to.
 */
function deploy(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, "deploy", ...args], {
      cwd: app,
      env: {
        ...userEnv(),
        HOME: home,
        CREEK_SANDBOX_API_URL: base,
        CREEK_API_URL: base,
        CREEK_TOKEN: "",
        NO_COLOR: "1",
        ...env,
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

/** stdout must be one JSON document, nothing before or after it. */
function parseOnlyJson(stdout: string): Record<string, unknown> {
  expect(stdout.trim().startsWith("{"), `stdout starts with non-JSON:\n${stdout}`).toBe(true);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe.skipIf(!existsSync(CLI))("creek deploy --json: stdout is one JSON document (#62)", () => {
  test("sandbox deploy with a noisy build", async () => {
    const r = await deploy(["--sandbox", "--json"]);
    const out = parseOnlyJson(r.stdout);
    expect(out).toMatchObject({ ok: true, mode: "sandbox" });
    expect(r.code).toBe(0);
    // Every source that used to leak is still visible, on stderr.
    expect(r.stderr).toContain("Terms of Service");
    // npm's own script banner ("> build" on npm 11, "npm notice run build" on
    // stderr from npm 12) is covered by stdout parsing as JSON; its wording
    // depends on the npm version, so it isn't asserted here.
    expect(r.stderr).toContain("LEAK-BUILD-STDOUT");
    expect(r.stderr).toContain("LEAK-GRANDCHILD");
    expect(r.stderr).toContain("BUILD-STDERR");
    expect(r.stdout).not.toContain("LEAK-");
  });

  test("sandbox deploy with --skip-build (the Terms notice alone used to break it)", async () => {
    const r = await deploy(["--sandbox", "--skip-build", "--json"]);
    expect(parseOnlyJson(r.stdout)).toMatchObject({ ok: true });
    expect(r.stderr).toContain("Terms of Service");
  });

  test("production deploy through the control-plane API", async () => {
    const r = await deploy(["--prod", "--json"], { CREEK_TOKEN: "test-token" });
    expect(parseOnlyJson(r.stdout)).toMatchObject({ ok: true, mode: "production" });
    expect(r.stderr).toContain("LEAK-GRANDCHILD");
  });

  test("the production build log records whether the build ran", async () => {
    const built = await deploy(["--prod", "--json"], { CREEK_TOKEN: "test-token" });
    expect(built.code, built.stderr).toBe(0);
    expect(buildLogs.join("\n")).toContain("ran: npm run build");

    buildLogs = [];
    const skipped = await deploy(["--prod", "--skip-build", "--json"], {
      CREEK_TOKEN: "test-token",
    });
    expect(skipped.code, skipped.stderr).toBe(0);
    const log = buildLogs.join("\n");
    expect(log).toContain("build skipped (--skip-build)");
    expect(log).not.toContain("ran: npm run build");
  });

  test("a failing build still yields one JSON error document", async () => {
    const r = await deploy(["--sandbox", "--json"], { FAIL_BUILD: "1" });
    expect(parseOnlyJson(r.stdout)).toMatchObject({ ok: false, error: "build_failed" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("LEAK-BUILD-STDOUT");
  });

  test("template deploy: a rejected template name is a JSON error", async () => {
    const r = await deploy(["--template", "../etc", "--sandbox", "--json"]);
    expect(parseOnlyJson(r.stdout)).toMatchObject({ ok: false, error: "invalid_template" });
    expect(r.code).toBe(1);
  });

  test("template deploy: malformed --data is a JSON error", async () => {
    const r = await deploy(["--template", "landing", "--data", "{not json", "--sandbox", "--json"]);
    expect(parseOnlyJson(r.stdout)).toMatchObject({ ok: false, error: "invalid_data" });
    expect(r.code).toBe(1);
  });

  test("JSON mode switched on by a pipe, without --json", async () => {
    const r = await deploy(["--sandbox"]);
    expect(parseOnlyJson(r.stdout)).toMatchObject({ ok: true });
  });
});
