/**
 * Every `creek deploy --json` outcome names the deployment it created
 * (`deploymentId`; `sandboxId` for a sandbox), and a deploy that is not over
 * points at `creek deployments wait <id> --json`, so an agent can follow it
 * to a result with one id.
 *
 * Runs the built CLI against a local stand-in for the control-plane and
 * sandbox APIs whose deployment status each test picks.
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
const DEP = "d0000001-0000-4000-8000-000000000001";

let server: Server;
let base = "";
/** What GET /projects/:p/deployments/:id answers in the current test. */
let deploymentBody: Record<string, unknown> = {};
/** What the sandbox status endpoint answers in the current test. */
let sandboxStatus: Record<string, unknown> = {};
/** Whether POST /github/deploy-latest has run (the list then shows its row). */
let githubTriggered = false;
let listsAfterTrigger = 0;
/** A newer deploy of another commit shows up before the triggered one. */
let otherRowFirst = false;
/** GET /deployments/:id never answers. */
let hangStatus = false;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    for await (const _ of req) void _;
    const p = new URL(req.url ?? "/", base).pathname;
    const json = (body: unknown, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    if (p === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>ok</title>");
    }
    if (p === "/api/sandbox/deploy") {
      return json({
        sandboxId: "sb000001",
        status: "queued",
        statusUrl: `${base}/api/sandbox/sb000001/status`,
        previewUrl: `${base}/`,
        expiresAt,
      });
    }
    if (p === "/api/sandbox/sb000001/status") {
      // The connection drops after the sandbox was created.
      if (sandboxStatus.drop) return res.destroy();
      return json({ ...sandboxStatus, expiresAt });
    }
    if (p === "/api/auth/get-session") {
      return json({ user: { id: "u1", email: "t@example.com", name: "T" }, session: {} });
    }
    if (req.method === "GET" && /^\/projects\/[^/]+$/.test(p)) {
      return json({ id: "p1", slug: "app", organizationId: "o1", productionBranch: "main" });
    }
    if (req.method === "POST" && p.endsWith("/deployments")) {
      return json({ deployment: { id: DEP, version: 1, status: "queued" } }, 201);
    }
    if (req.method === "GET" && p.endsWith(`/deployments/${DEP}`)) {
      if (hangStatus) return; // never answers
      return json(deploymentBody);
    }
    if (req.method === "POST" && p === "/github/deploy-latest") {
      githubTriggered = true;
      return json({ ok: true, commitSha: "abc1234def567890", branch: "main" });
    }
    if (req.method === "GET" && p.endsWith("/deployments")) {
      // Before the trigger: one old row. After: the row the push created.
      const old = { id: "old-row", version: 1, status: "active", createdAt: 1 };
      const d = deploymentBody.deployment as Record<string, unknown>;
      if (!githubTriggered) return json([old]);
      listsAfterTrigger++;
      const mine = { ...d, version: 2, branch: "main", commitSha: "abc1234def56", createdAt: 2 };
      // Someone else's deploy of another commit, newer than ours. With
      // `otherRowFirst`, it is the only new row on the first poll.
      const other = {
        id: "other-row",
        version: 3,
        status: "active",
        branch: "main",
        commitSha: "fff0000aaa11",
        createdAt: 3,
      };
      if (!otherRowFirst) return json([mine, old]);
      return json(listsAfterTrigger === 1 ? [other, old] : [other, mine, old]);
    }
    return json({ ok: true });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

let app: string;
let home: string;

beforeEach(() => {
  githubTriggered = false;
  listsAfterTrigger = 0;
  otherRowFirst = false;
  hangStatus = false;
  app = mkdtempSync(join(tmpdir(), "creek-follow-id-"));
  home = mkdtempSync(join(tmpdir(), "creek-follow-home-"));
  mkdirSync(join(app, "dist"));
  writeFileSync(join(app, "dist/index.html"), "<!doctype html><title>ok</title>");
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", private: true }));
  writeFileSync(join(app, "creek.toml"), '[project]\nname = "app"\n\n[build]\noutput = "dist"\n');
});

afterEach(() => {
  rmSync(app, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

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
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; out: Record<string, any>; stderr: string }> {
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
      try {
        done({ code, out: JSON.parse(stdout), stderr });
      } catch {
        fail(new Error(`stdout is not one JSON document:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });
}

const prod = (extra: string[] = []) =>
  deploy(["--prod", "--skip-build", "--no-cache", "--json", ...extra], {
    CREEK_TOKEN: "test-token",
  });
const crumbs = (out: Record<string, any>) =>
  (out.breadcrumbs ?? []).map((b: { command: string }) => b.command);

describe.skipIf(!existsSync(CLI))("creek deploy --json names the deployment", () => {
  test("success carries deploymentId", async () => {
    deploymentBody = { deployment: { id: DEP, status: "active", version: 1 }, url: `${base}/` };
    const r = await prod();
    expect(r.code, r.stderr).toBe(0);
    expect(r.out).toMatchObject({ ok: true, deploymentId: DEP });
  });

  test("a failed deploy carries deploymentId, the reason and a log breadcrumb", async () => {
    deploymentBody = {
      deployment: { id: DEP, status: "failed", failedStep: "activate", errorMessage: "boom" },
      url: null,
      previewUrl: `${base}/`,
      errorCode: "CK-X",
      errorHint: "do y",
    };
    const r = await prod();
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({
      ok: false,
      error: "deploy_failed",
      deploymentId: DEP,
      status: "failed",
      failedStep: "activate",
      errorCode: "CK-X",
    });
    expect(crumbs(r.out)).toContain(`creek deployments logs ${DEP} --json`);
  });

  test("a cancelled deploy carries deploymentId", async () => {
    deploymentBody = { deployment: { id: DEP, status: "cancelled" }, url: null };
    const r = await prod();
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false, error: "cancelled", deploymentId: DEP });
  });

  test("a timeout carries deploymentId, the last status and a pasteable wait", async () => {
    deploymentBody = { deployment: { id: DEP, status: "deploying" }, url: null };
    const r = await prod(["--wait", "1s"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({
      ok: false,
      error: "timeout",
      deploymentId: DEP,
      status: "deploying",
    });
    expect(crumbs(r.out)[0]).toBe(`creek deployments wait ${DEP} --json`);
  });

  test("--from-github: a failed deploy has an error code, a message and deploymentId", async () => {
    deploymentBody = {
      deployment: { id: DEP, status: "failed", failedStep: "build", errorMessage: "npm ERR" },
      url: null,
      previewUrl: `${base}/`,
      errorCode: "CK-BUILD",
      errorHint: "fix it",
    };
    const r = await deploy(["--from-github", "--project", "app", "--prod", "--json"], {
      CREEK_TOKEN: "test-token",
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({
      ok: false,
      error: "deploy_failed",
      message: "npm ERR",
      deploymentId: DEP,
      status: "failed",
      source: "github",
      failedStep: "build",
      errorCode: "CK-BUILD",
    });
    expect(crumbs(r.out)).toContain(`creek deployments logs ${DEP} --json`);
    expect(r.out).toMatchObject({ matchedBy: "commit" });
  });

  test("--from-github reports a known failure even when the reason read hangs", async () => {
    hangStatus = true;
    deploymentBody = {
      deployment: { id: DEP, status: "failed", failedStep: "build", errorMessage: "npm ERR" },
    };
    const started = Date.now();
    const r = await deploy(["--from-github", "--project", "app", "--prod", "--json"], {
      CREEK_TOKEN: "test-token",
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false, error: "deploy_failed", deploymentId: DEP });
    // Reported without the enrichment, once the bounded read gives up.
    expect(r.out).not.toHaveProperty("errorCode");
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  test("--from-github follows the triggered commit's row, not another new row that landed first", async () => {
    otherRowFirst = true;
    deploymentBody = {
      deployment: { id: DEP, status: "failed", failedStep: "build", errorMessage: "npm ERR" },
      url: null,
      previewUrl: `${base}/`,
    };
    const r = await deploy(["--from-github", "--project", "app", "--prod", "--json"], {
      CREEK_TOKEN: "test-token",
    });
    expect(r.out).toMatchObject({ deploymentId: DEP, matchedBy: "commit" });
    expect(r.out).not.toHaveProperty("commitMatched");
    expect(listsAfterTrigger).toBeGreaterThan(1);
  });

  test("a sandbox that fails after it was created carries sandboxId", async () => {
    sandboxStatus = {
      sandboxId: "sb000001",
      status: "failed",
      failedStep: "activate",
      errorMessage: "bad worker",
    };
    const r = await deploy(["--sandbox", "--skip-build", "--json"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false, error: "deploy_failed", sandboxId: "sb000001" });
    expect(crumbs(r.out)).toContain("creek status sb000001 --json");
  });

  test("a connection lost after the sandbox was created never suggests re-running the deploy", async () => {
    // The POST created a sandbox; a re-run would create a second one.
    sandboxStatus = { drop: true };
    const r = await deploy(["--sandbox", "--skip-build", "--json"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false, sandboxId: "sb000001" });
    expect(r.out.retryable).not.toBe(true);
    expect(crumbs(r.out)).toEqual(["creek status sb000001 --json"]);
  });

  test("a static-directory sandbox deploy lost the same way does not suggest a re-run either", async () => {
    sandboxStatus = { drop: true };
    rmSync(join(app, "creek.toml"));
    rmSync(join(app, "package.json"));
    const r = await deploy(["dist", "--sandbox", "--json"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false, sandboxId: "sb000001" });
    expect(crumbs(r.out)).toEqual(["creek status sb000001 --json"]);
  });

  test("a verify_failed sandbox result has a message", async () => {
    // A preview URL nothing answers on.
    sandboxStatus = { sandboxId: "sb000001", status: "active", previewUrl: "http://127.0.0.1:9/" };
    const r = await deploy(["--sandbox", "--skip-build", "--json"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false, error: "verify_failed", sandboxId: "sb000001" });
    expect(r.out.message).toMatch(/did not answer/);
  });
});
