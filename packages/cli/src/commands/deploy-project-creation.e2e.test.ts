/**
 * When `creek deploy` creates the project, end to end through the built CLI.
 *
 * A first deploy creates its project. It used to do that before it built or
 * looked for anything to upload, so a deploy that stopped there — no build
 * output, a failed build — left an empty project behind: listed by
 * `creek projects`, holding its name, never deployed. The project is now
 * created only once there is a bundle to deploy.
 *
 * Runs against a local stand-in for the control-plane API that records every
 * request and has no projects.
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
let requests: Array<{ method: string; path: string }> = [];
/** Slugs created through POST /projects during the test. */
let created: string[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const p = new URL(req.url ?? "/", base).pathname;
    requests.push({ method: req.method ?? "", path: p });
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
    const one = /^\/projects\/([^/]+)$/.exec(p);
    if (req.method === "GET" && one) {
      if (!created.includes(one[1]!)) {
        return json({ error: "not_found", message: "Project not found" }, 404);
      }
      return json({ id: "p1", slug: one[1], organizationId: "o1", productionBranch: "main" });
    }
    if (req.method === "POST" && p === "/projects") {
      const { slug } = JSON.parse(body) as { slug: string };
      created.push(slug);
      return json({ project: { id: "p1", slug } }, 201);
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
  requests = [];
  created = [];
  app = mkdtempSync(join(tmpdir(), "creek-project-creation-app-"));
  home = mkdtempSync(join(tmpdir(), "creek-project-creation-home-"));
  writeFileSync(join(app, "creek.toml"), '[project]\nname = "app"\n\n[build]\noutput = "dist"\n');
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

function deploy(
  args: string[] = ["--prod", "--json"],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, "deploy", ...args], {
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

const sent = (method: string, path: string) =>
  requests.findIndex((r) => r.method === method && r.path === path);

// Runs the built CLI: skipped, like the other built-CLI suites, when dist/ is absent.
describe.skipIf(!existsSync(CLI))("creek deploy and the project it creates", () => {
  test("nothing to deploy: the project is not created", async () => {
    // creek.toml names a project, but there is no dist/ to upload.
    const { code, stdout } = await deploy();

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: "nothing_to_deploy" });
    expect(created).toEqual([]);
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  test("a failed build: the project is not created", async () => {
    writeFileSync(
      join(app, "creek.toml"),
      '[project]\nname = "app"\n\n[build]\ncommand = "exit 3"\noutput = "dist"\n',
    );

    const { code, stdout } = await deploy();

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: "build_failed" });
    expect(created).toEqual([]);
  });

  test("a first deploy creates the project, then its deployment", async () => {
    mkdirSync(join(app, "dist"));
    writeFileSync(join(app, "dist/index.html"), "<!doctype html><title>ok</title>");

    const { code, stdout } = await deploy();

    expect(code, stdout).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true });
    expect(created).toEqual(["app"]);
    const createdAt = sent("POST", "/projects");
    const deployedAt = sent("POST", "/projects/p1/deployments");
    expect(createdAt).toBeGreaterThanOrEqual(0);
    expect(deployedAt).toBeGreaterThan(createdAt);
  });

  test("a deploy to a project that exists creates nothing", async () => {
    created = ["app"];
    mkdirSync(join(app, "dist"));
    writeFileSync(join(app, "dist/index.html"), "<!doctype html><title>ok</title>");

    const { code, stdout } = await deploy();

    expect(code, stdout).toBe(0);
    expect(sent("POST", "/projects")).toBe(-1);
    expect(sent("POST", "/projects/p1/deployments")).toBeGreaterThanOrEqual(0);
  });
});
