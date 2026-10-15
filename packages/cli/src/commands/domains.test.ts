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
const lsCmd = subs.ls;
const rmCmd = subs.rm;

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
  testDir = join(
    tmpdir(),
    `creek-domains-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
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
    HttpResponse.json([{ id: DOM_ID, projectId: "p1", hostname: HOST, status, createdAt: 0 }]),
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
          dns: { cname: { name: HOST, target: "cname.bycreek.com" } },
        }),
      ),
    );

    const code = await runExit(showCmd.run!({ args: { hostname: HOST } } as never));

    expect(code).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      project: SLUG,
      dns: { cname: { name: HOST, target: "cname.bycreek.com" } },
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
          message:
            "Domain not verified yet (edge status: pending). Point DNS to cname.bycreek.com, then retry.",
        }),
      ),
    );

    const code = await runExit(activateCmd.run!({ args: { hostname: HOST } } as never));

    expect(code).toBe(1);
    const out = json();
    expect(out).toMatchObject({ ok: false, status: "pending_dns", hostname: HOST });
    expect(out.message).toMatch(/not verified/i);
    // Points the user at where the DNS records are retrievable.
    expect(
      out.breadcrumbs.some((b: { command: string }) => b.command.startsWith("creek domains show")),
    ).toBe(true);
  });

  it("keeps the API's pending_edge status instead of reporting pending_dns", async () => {
    server.use(
      listHandler("pending"),
      http.post(`${API}/projects/${SLUG}/domains/${DOM_ID}/activate`, () =>
        HttpResponse.json({
          ok: false,
          status: "pending_edge",
          message: "The domain isn't registered with the edge yet; retry shortly.",
        }),
      ),
    );

    const code = await runExit(activateCmd.run!({ args: { hostname: HOST } } as never));

    expect(code).toBe(1);
    expect(json()).toMatchObject({
      ok: false,
      error: "pending_edge",
      status: "pending_edge",
      hostname: HOST,
    });
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

// Every command must emit structured JSON (not human text) on the common
// failure states, so a script/agent parsing stdout gets a machine-readable
// error instead of a JSON.parse failure.
describe("creek domains structured errors (JSON mode)", () => {
  it("emits not_authenticated when there is no token", async () => {
    // Empty (not deleted) so getToken doesn't fall back to a real ~/.creek
    // config on the dev machine; requireClient's `!token` check still fires.
    process.env.CREEK_TOKEN = "";
    const code = await runExit(lsCmd.run!({ args: {} } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_authenticated" });
  });

  it("emits no_project when there is no creek.toml and no --project", async () => {
    rmSync(join(testDir, "creek.toml"));
    const code = await runExit(lsCmd.run!({ args: {} } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "no_project" });
  });

  it("emits invalid_config when creek.toml is malformed", async () => {
    writeFileSync(join(testDir, "creek.toml"), "this is not = valid = toml ===");
    const code = await runExit(lsCmd.run!({ args: {} } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "invalid_config" });
  });

  it("emits api_error when the API call fails", async () => {
    server.use(
      http.get(`${API}/projects/${SLUG}/domains`, () => new HttpResponse(null, { status: 500 })),
    );
    const code = await runExit(lsCmd.run!({ args: {} } as never));
    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "api_error" });
  });

  it("dry-run does not DELETE the domain", async () => {
    let deleted = false;
    server.use(
      listHandler("active"),
      http.delete(`${API}/projects/${SLUG}/domains/${DOM_ID}`, () => {
        deleted = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const code = await runExit(rmCmd.run!({ args: { hostname: HOST, "dry-run": true } } as never));
    expect(code).toBe(0);
    expect(deleted).toBe(false);
    expect(json()).toMatchObject({
      ok: true,
      mode: "dry-run",
      wouldExecute: true,
      hostname: HOST,
    });
    expect(json().nextStep).toBe(`creek domains rm ${HOST} --project ${SLUG} --json`);
    expect(json().sideEffects).toEqual([
      `Remove the project domain record for ${HOST}`,
      "Cloudflare custom-hostname cleanup is attempted only when a CF hostname ID and CLOUDFLARE_ZONE_ID are present; the project record is still removed if that cleanup fails",
    ]);
  });

  it("emits a structured not_found for a string that is not a hostname", async () => {
    server.use(listHandler("pending"));
    for (const hostname of ["https://course.example.com", "course", "course example.com"]) {
      stdout = "";
      const code = await runExit(rmCmd.run!({ args: { hostname } } as never));
      expect(code, hostname).toBe(1);
      expect(json()).toMatchObject({ ok: false, error: "not_found", hostname });
    }
  });
});

describe("creek domains rm, run twice", () => {
  type Row = { id: string; projectId: string; hostname: string; status: string; createdAt: number };
  let rows: Row[];
  let deletes: number;

  // Like the control-plane: DELETE removes the row, and 404s once it's gone.
  function liveServer() {
    rows = [{ id: DOM_ID, projectId: "p1", hostname: HOST, status: "active", createdAt: 0 }];
    deletes = 0;
    server.use(
      http.get(`${API}/projects/${SLUG}/domains`, () => HttpResponse.json(rows)),
      http.delete(`${API}/projects/${SLUG}/domains/:id`, ({ params }) => {
        deletes++;
        const before = rows.length;
        rows = rows.filter((r) => r.id !== params.id);
        if (rows.length === before)
          return HttpResponse.json(
            { error: "not_found", message: "Domain not found" },
            { status: 404 },
          );
        return HttpResponse.json({ ok: true });
      }),
    );
  }

  it("a second rm of the same hostname succeeds with alreadyAbsent", async () => {
    liveServer();
    expect(await runExit(rmCmd.run!({ args: { hostname: HOST } } as never))).toBe(0);
    expect(json()).toMatchObject({ ok: true, hostname: HOST, alreadyAbsent: false, removed: true });

    stdout = "";
    expect(await runExit(rmCmd.run!({ args: { hostname: HOST } } as never))).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      hostname: HOST,
      alreadyAbsent: true,
      removed: false,
      project: SLUG,
    });
    expect(json().message).toContain("nothing was removed");
    // Nothing listed, so nothing to DELETE.
    expect(deletes).toBe(1);
  });

  it("matches the hostname case-insensitively and reports it normalized", async () => {
    liveServer();
    rows = [];
    expect(await runExit(rmCmd.run!({ args: { hostname: "Course.Example.COM" } } as never))).toBe(
      0,
    );
    expect(json()).toMatchObject({ ok: true, hostname: HOST, alreadyAbsent: true });
  });

  it("a padded hostname still finds and removes the listed domain", async () => {
    liveServer();
    expect(await runExit(rmCmd.run!({ args: { hostname: `  ${HOST}  ` } } as never))).toBe(0);
    expect(json()).toMatchObject({ ok: true, hostname: HOST, alreadyAbsent: false, removed: true });
    expect(deletes).toBe(1);
    expect(rows).toEqual([]);
  });

  it("a removal that loses to a concurrent one reports alreadyAbsent", async () => {
    liveServer();
    // The other removal lands between this one's list and its DELETE.
    server.use(
      http.delete(`${API}/projects/${SLUG}/domains/${DOM_ID}`, () => {
        rows = [];
        return HttpResponse.json(
          { error: "not_found", message: "Domain not found" },
          { status: 404 },
        );
      }),
    );
    expect(await runExit(rmCmd.run!({ args: { hostname: HOST } } as never))).toBe(0);
    expect(json()).toMatchObject({ ok: true, alreadyAbsent: true, removed: false });
  });

  it("a 404 for a domain that is still listed is an error, not alreadyAbsent", async () => {
    liveServer();
    server.use(
      http.delete(`${API}/projects/${SLUG}/domains/${DOM_ID}`, () =>
        HttpResponse.json({ error: "not_found", message: "Project not found" }, { status: 404 }),
      ),
    );
    expect(await runExit(rmCmd.run!({ args: { hostname: HOST } } as never))).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "delete_failed", status: 404 });
    expect(json().alreadyAbsent).toBeUndefined();
  });

  it("--dry-run on a hostname that is gone plans nothing and says alreadyAbsent", async () => {
    liveServer();
    rows = [];
    expect(await runExit(rmCmd.run!({ args: { hostname: HOST, "dry-run": true } } as never))).toBe(
      0,
    );
    expect(json()).toMatchObject({
      ok: true,
      mode: "dry-run",
      wouldExecute: false,
      alreadyAbsent: true,
      hostname: HOST,
    });
    expect(deletes).toBe(0);
  });
});

describe("creek domains add", () => {
  it("is idempotent — re-adding the same hostname surfaces the existing record + DNS, not an error", async () => {
    server.use(
      http.post(`${API}/projects/${SLUG}/domains`, () =>
        HttpResponse.json({
          domain: { id: DOM_ID, projectId: "p1", hostname: HOST, status: "pending", createdAt: 0 },
          verification: { cname: { name: HOST, target: "cname.bycreek.com" } },
          idempotent: true,
        }),
      ),
    );

    const code = await runExit(addCmd.run!({ args: { hostname: HOST } } as never));

    expect(code).toBe(0);
    expect(json()).toMatchObject({
      ok: true,
      idempotent: true,
      verification: { cname: { target: "cname.bycreek.com" } },
    });
  });
});
