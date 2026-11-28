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
      const key = req.headers["x-api-key"];
      if (key === '"crk_sk_live_quotedSecretValue"') {
        return json({ message: "Invalid API key.", code: "INVALID_API_KEY" }, 403);
      }
      if (key === "tok_unusable") {
        return json({ error: "team_mismatch", message: "Owner left team" }, 403);
      }
      if (key === "tok_edge_blocked") {
        res.writeHead(403, {
          "content-type": "text/html",
          "cf-ray": "ray123-DFW",
          "cf-mitigated": "challenge",
        });
        return res.end("<html>Attention Required!</html>");
      }
      return json({ user: { id: "u1", email: "t@example.com", name: "T" }, session: {} });
    }
    if (p === "/api-keys/self") {
      if (req.headers["x-api-key"] === "tok_unusable") {
        return json({
          id: "k1",
          name: "ci",
          start: "crk_sk_live_unUs",
          prefix: null,
          legacy: false,
          team: { id: "o1", slug: "acme" },
          scopes: ["deploy:production"],
          role: null,
          effectiveScopes: [],
          access: "none",
          enabled: true,
          expiresAt: null,
          expired: false,
          createdAt: "2026-01-01T00:00:00Z",
          lastUsedAt: null,
          warning: "The key's owner is no longer a member of the team.",
        });
      }
      return json({ error: "unauthorized", message: "Invalid API key" }, 401);
    }
    if (req.method === "GET" && /^\/projects\/[^/]+$/.test(p)) {
      return json({ id: "p1", slug: "app", organizationId: "o1", productionBranch: "main" });
    }
    if (req.method === "POST" && p.endsWith("/deployments")) {
      return json({ deployment: { id: "d1", version: 1, status: "pending" } }, 201);
    }
    if (req.method === "GET" && p.endsWith("/deployments/d1")) {
      if (req.headers["x-api-key"] === "tok_custom_domain") {
        return json({
          deployment: { id: "d1", status: "active", version: 5 },
          url: `${base}/`,
          defaultUrl: "https://app-acme.bycreek.com",
          primaryDomain: "app.example.com",
          customDomains: ["app.example.com"],
          previewUrl: "https://app-d1-acme.bycreek.com",
        });
      }
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
  env: Record<string, string | undefined> = {},
  cwd: string = app,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = {
    ...userEnv(),
    HOME: home,
    CREEK_SANDBOX_API_URL: base,
    CREEK_API_URL: base,
    CREEK_TOKEN: "",
    NO_COLOR: "1",
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, "deploy", ...args], {
      cwd,
      env: childEnv,
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

// Each test spawns the CLI, and most run a real `npm run build`: a second or
// two alone, far more under a full parallel suite, where vitest's 5 s default
// timed out the two-deploy test. deploy() fails a single run itself at 60 s,
// so allow two of those plus margin.
const E2E_TIMEOUT_MS = 130_000;

describe.skipIf(!existsSync(CLI))(
  "creek deploy --json: stdout is one JSON document (#62)",
  { timeout: E2E_TIMEOUT_MS },
  () => {
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
      const r = await deploy([
        "--template",
        "landing",
        "--data",
        "{not json",
        "--sandbox",
        "--json",
      ]);
      expect(parseOnlyJson(r.stdout)).toMatchObject({ ok: false, error: "invalid_data" });
      expect(r.code).toBe(1);
    });

    test("JSON mode switched on by a pipe, without --json", async () => {
      const r = await deploy(["--sandbox"]);
      expect(parseOnlyJson(r.stdout)).toMatchObject({ ok: true });
    });

    test("production deploy blames quoted CREEK_TOKEN without leaking the secret", async () => {
      const r = await deploy(["--prod", "--skip-build", "--json"], {
        CREEK_TOKEN: '"crk_sk_live_quotedSecretValue"',
      });
      const out = parseOnlyJson(r.stdout);
      expect(r.code).toBe(1);
      expect(out).toMatchObject({
        ok: false,
        error: "unauthorized",
        tokenSource: "env:CREEK_TOKEN",
        tokenFormatIssue: "wrapped_in_quotes",
      });
      expect(String(out.message)).toContain("CREEK_TOKEN");
      expect(String(out.message)).toContain("quotes");
      expect(r.stdout).not.toContain("quotedSecretValue");
    });

    test("production and --from-github deploys block NUL saved tokens before fetch without leaking", async () => {
      const nulHome = mkdtempSync(join(tmpdir(), "creek-nul-home-"));
      try {
        mkdirSync(join(nulHome, ".creek"), { recursive: true });
        writeFileSync(
          join(nulHome, ".creek", "config.json"),
          JSON.stringify({ token: "crk_sk_live_secretNulDeploy\0tail", tokenApiUrl: base }),
        );

        for (const args of [
          ["--prod", "--skip-build", "--json"],
          ["--from-github", "--project", "app", "--prod", "--json"],
        ]) {
          const r = await deploy(args, { HOME: nulHome, CREEK_TOKEN: undefined });
          const out = parseOnlyJson(r.stdout);
          expect(r.code).toBe(1);
          expect(out).toMatchObject({
            ok: false,
            error: "unauthorized",
            tokenSource: "config",
            tokenFormatIssue: "contains_nul",
          });
          expect(String(out.message)).toContain("could not be sent");
          expect(r.stdout).not.toContain("secretNulDeploy");
          expect(r.stderr).not.toContain("secretNulDeploy");
        }
      } finally {
        rmSync(nulHome, { recursive: true, force: true });
      }
    });

    test("production deploy reports key_unusable when key exists but cannot act", async () => {
      const r = await deploy(["--prod", "--skip-build", "--json"], { CREEK_TOKEN: "tok_unusable" });
      const out = parseOnlyJson(r.stdout);
      expect(r.code).toBe(1);
      expect(out).toMatchObject({
        ok: false,
        error: "key_unusable",
        tokenSource: "env:CREEK_TOKEN",
        key: { access: "none" },
      });
    });

    test("production deploy reports edge_blocked on non-JSON 403 HTML block", async () => {
      const r = await deploy(["--prod", "--skip-build", "--json"], {
        CREEK_TOKEN: "tok_edge_blocked",
      });
      const out = parseOnlyJson(r.stdout);
      expect(r.code).toBe(1);
      expect(out).toMatchObject({
        ok: false,
        error: "edge_blocked",
        status: 403,
        details: { nonJson: true, contentType: "text/html", cfRay: "ray123-DFW" },
      });
    });

    test("production deploy includes primaryDomain/customDomains and uses domains ls breadcrumb", async () => {
      const r = await deploy(["--prod", "--skip-build", "--json"], {
        CREEK_TOKEN: "tok_custom_domain",
      });
      const out = parseOnlyJson(r.stdout);
      expect(r.code).toBe(0);
      expect(out).toMatchObject({
        ok: true,
        url: `${base}/`,
        defaultUrl: "https://app-acme.bycreek.com",
        primaryDomain: "app.example.com",
        customDomains: ["app.example.com"],
        proof: { ok: true, url: `${base}/` },
      });
      const commands = (out.breadcrumbs as Array<{ command: string }>).map((b) => b.command);
      expect(commands).toContain("creek domains ls --project app --json");
      expect(commands.join("\n")).not.toContain("creek domains add");
    });

    test("monorepo --path --prod --skip-build separates buildTimeS from deployTimeS", async () => {
      const repo = mkdtempSync(join(tmpdir(), "creek-monorepo-e2e-"));
      try {
        mkdirSync(join(repo, "apps/web/dist"), { recursive: true });
        writeFileSync(
          join(repo, "apps/web/dist/index.html"),
          "<!doctype html><title>monorepo</title>",
        );
        writeFileSync(
          join(repo, "apps/web/package.json"),
          JSON.stringify({ name: "web", private: true }),
        );
        writeFileSync(
          join(repo, "apps/web/creek.toml"),
          '[project]\nname = "app"\n\n[build]\ncommand = "npm run build"\noutput = "dist"\n',
        );

        const r = await deploy(
          ["--path", "apps/web", "--prod", "--skip-build", "--json"],
          { CREEK_TOKEN: "test-token" },
          repo,
        );
        expect(r.code, r.stderr).toBe(0);
        const out = parseOnlyJson(r.stdout);
        expect(out).toMatchObject({
          ok: true,
          mode: "production",
          project: "app",
          buildSkipped: true,
          buildTimeS: null,
        });
        expect(typeof out.deployTimeS).toBe("number");
        expect(buildLogs.join("\n")).toContain("build skipped (--skip-build)");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    test("non-skipped deploys report buildSkipped: false with numeric buildTimeS and deployTimeS", async () => {
      const prod = await deploy(["--prod", "--json"], { CREEK_TOKEN: "test-token" });
      expect(prod.code, prod.stderr).toBe(0);
      const prodOut = parseOnlyJson(prod.stdout);
      expect(prodOut.buildSkipped).toBe(false);
      expect(typeof prodOut.buildTimeS).toBe("number");
      expect(typeof prodOut.deployTimeS).toBe("number");

      const sandbox = await deploy(["--sandbox", "--json"]);
      expect(sandbox.code, sandbox.stderr).toBe(0);
      const sandboxOut = parseOnlyJson(sandbox.stdout);
      expect(sandboxOut.buildSkipped).toBe(false);
      expect(typeof sandboxOut.buildTimeS).toBe("number");
      expect(typeof sandboxOut.deployTimeS).toBe("number");
    });

    test("--skip-build with empty dist fails with nothing_to_deploy", async () => {
      const emptyApp = mkdtempSync(join(tmpdir(), "creek-empty-dist-e2e-"));
      try {
        mkdirSync(join(emptyApp, "dist"), { recursive: true });
        writeFileSync(
          join(emptyApp, "package.json"),
          JSON.stringify({ name: "app", private: true }),
        );
        writeFileSync(
          join(emptyApp, "creek.toml"),
          '[project]\nname = "app"\n\n[build]\ncommand = "pnpm build"\noutput = "dist"\n',
        );

        const r = await deploy(
          ["--prod", "--skip-build", "--json"],
          { CREEK_TOKEN: "test-token" },
          emptyApp,
        );
        expect(r.code).toBe(1);
        const out = parseOnlyJson(r.stdout);
        expect(out).toMatchObject({
          ok: false,
          error: "nothing_to_deploy",
          buildSkipped: true,
        });
        expect(String(out.message)).toContain("--skip-build");
      } finally {
        rmSync(emptyApp, { recursive: true, force: true });
      }
    });

    test("static-site monorepo sandbox deploys emit buildSkipped, buildTimeS: null, and deployTimeS", async () => {
      const repo = mkdtempSync(join(tmpdir(), "creek-static-monorepo-e2e-"));
      try {
        // Pure index.html path (resolved.source === "index.html")
        mkdirSync(join(repo, "apps/site"), { recursive: true });
        writeFileSync(join(repo, "apps/site/index.html"), "<!doctype html><title>static</title>");

        const pure = await deploy(
          ["--path", "apps/site", "--sandbox", "--skip-build", "--json"],
          {},
          repo,
        );
        expect(pure.code, pure.stderr).toBe(0);
        const pureOut = parseOnlyJson(pure.stdout);
        expect(pureOut).toMatchObject({
          ok: true,
          mode: "sandbox",
          buildSkipped: true,
          buildTimeS: null,
        });
        expect(typeof pureOut.deployTimeS).toBe("number");

        // No-package.json static fallback (creek.toml + index.html, no package.json)
        writeFileSync(
          join(repo, "apps/site/creek.toml"),
          '[project]\nname = "site"\n\n[build]\ncommand = "npm run build"\noutput = "."\n',
        );

        const fallback = await deploy(["--path", "apps/site", "--sandbox", "--json"], {}, repo);
        expect(fallback.code, fallback.stderr).toBe(0);
        const fallbackOut = parseOnlyJson(fallback.stdout);
        expect(fallbackOut).toMatchObject({
          ok: true,
          mode: "sandbox",
          buildSkipped: false,
          buildTimeS: null,
        });
        expect(typeof fallbackOut.deployTimeS).toBe("number");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  },
);
