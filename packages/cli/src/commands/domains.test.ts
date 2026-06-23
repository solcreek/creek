import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { domainsCommand } from "./domains.js";

// Drive `creek domains show/activate/add` against MSW. Tests run non-TTY, so
// resolveJsonMode is true and the commands emit the JSON an agent reads — we
// assert on that. The B4 contract: DNS records are retrievable any time via
// `show`, and `activate` is honest (only "active" when the edge confirms,
// otherwise pending_dns + non-zero exit). Fabricated IDs only.
const API = "https://cp.test";
const SLUG = "myproj";
const HOST = "course.example.com";
const DOM_ID = "dom-1";

type Sub = { run?: (ctx: never) => Promise<unknown> };
const subs = domainsCommand.subCommands as Record<string, Sub>;
const showCmd = subs.show;
const activateCmd = subs.activate;
const addCmd = subs.add;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}

let stdout: string;
let testDir: string;
let prevCwd: string;
beforeEach(() => {
  stdout = "";
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  process.env.CREEK_API_URL = API;
  process.env.CREEK_TOKEN = "tok-test";

  // getProjectSlug() reads creek.toml from the current working directory.
  testDir = join(tmpdir(), `creek-domains-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, "creek.toml"), `[project]\nname = "${SLUG}"\n`);
  prevCwd = process.cwd();
  process.chdir(testDir);
});
afterEach(() => {
  process.chdir(prevCwd);
  vi.restoreAllMocks();
  delete process.env.CREEK_API_URL;
  delete process.env.CREEK_TOKEN;
  rmSync(testDir, { recursive: true, force: true });
});

async function runExit(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    throw new Error("expected the command to call process.exit");
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}
function json() {
  return JSON.parse(stdout);
}

/** MSW handler: the project's domain list (used to resolve hostname → id). */
function listHandler(status: string) {
  return http.get(`${API}/projects/${SLUG}/domains`, () =>
    HttpResponse.json([
      { id: DOM_ID, projectId: "p1", hostname: HOST, status, createdAt: 0 },
    ]),
  );
}

describe("creek domains show", () => {
  it("returns the DNS records and live status any time, not just at add", async () => {
    server.use(
      listHandler("pending"),
      http.get(`${API}/projects/${SLUG}/domains/${DOM_ID}`, () =>
        HttpResponse.json({
          id: DOM_ID,
          projectId: "p1",
          hostname: HOST,
          status: "pending",
          createdAt: 0,
          dns: { cname: { name: HOST, target: "cname.creek.dev" } },
        }),
      ),
    );

    const code = await runExit(showCmd.run!({ args: { hostname: HOST } } as never));

    expect(code).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      project: SLUG,
      dns: { cname: { name: HOST, target: "cname.creek.dev" } },
    });
  });

  it("exits 1 when the hostname isn't on the project", async () => {
    server.use(listHandler("pending"));
    const code = await runExit(showCmd.run!({ args: { hostname: "nope.example.com" } } as never));
    expect(code).toBe(1);
  });
});

describe("creek domains activate", () => {
  it("reports active when the edge confirms the hostname", async () => {
    server.use(
      listHandler("pending"),
      http.post(`${API}/projects/${SLUG}/domains/${DOM_ID}/activate`, () =>
        HttpResponse.json({ ok: true, status: "active" }),
      ),
    );

    const code = await runExit(activateCmd.run!({ args: { hostname: HOST } } as never));

    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, status: "active", hostname: HOST });
  });

  it("does not claim active when DNS isn't resolving — exits 1 with pending_dns", async () => {
    server.use(
      listHandler("pending"),
      http.post(`${API}/projects/${SLUG}/domains/${DOM_ID}/activate`, () =>
        HttpResponse.json({
          ok: false,
          status: "pending_dns",
          message: "Domain not verified yet (edge status: pending). Point DNS to cname.creek.dev, then retry.",
        }),
      ),
    );

    const code = await runExit(activateCmd.run!({ args: { hostname: HOST } } as never));

    expect(code).toBe(1);
    const out = json();
    expect(out).toMatchObject({ ok: false, status: "pending_dns", hostname: HOST });
    expect(out.message).toMatch(/not verified/i);
    // Points the user at where the DNS records are retrievable.
    expect(out.breadcrumbs.some((b: { command: string }) => b.command.startsWith("creek domains show"))).toBe(true);
  });

  it("labels a no-edge activation as a manual override", async () => {
    server.use(
      listHandler("pending"),
      http.post(`${API}/projects/${SLUG}/domains/${DOM_ID}/activate`, () =>
        HttpResponse.json({ ok: true, status: "active", manual: true }),
      ),
    );

    const code = await runExit(activateCmd.run!({ args: { hostname: HOST } } as never));

    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, status: "active", manual: true });
  });
});

describe("creek domains add", () => {
  it("is idempotent — re-adding the same hostname surfaces the existing record + DNS, not an error", async () => {
    server.use(
      http.post(`${API}/projects/${SLUG}/domains`, () =>
        HttpResponse.json({
          domain: { id: DOM_ID, projectId: "p1", hostname: HOST, status: "pending", createdAt: 0 },
          verification: { cname: { name: HOST, target: "cname.creek.dev" } },
          idempotent: true,
        }),
      ),
    );

    const code = await runExit(addCmd.run!({ args: { hostname: HOST } } as never));

    expect(code).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      idempotent: true,
      verification: { cname: { target: "cname.creek.dev" } },
    });
  });
});
