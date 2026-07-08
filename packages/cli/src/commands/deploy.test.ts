import { describe, test, expect, vi, afterEach } from "vitest";
import consola from "consola";
import { CreekAuthError, CreekApiError } from "@solcreek/sdk";
import {
  patchBareNodeImports,
  findNewDeployment,
  makeProgress,
  sameOriginApiHint,
  ephemeralSandboxDbWarning,
  resolveDeployEnv,
  parseWaitDuration,
  withTimeout,
  stageDeploymentBundle,
  CLI_TERMINAL_STATUSES,
  CLI_IN_FLIGHT_STATUSES,
  type CliDeployment,
} from "./deploy.js";

describe("stageDeploymentBundle (separate binary server files)", () => {
  function mockClient() {
    const serverFileUploads: Array<{ name: string; bytes: Uint8Array }> = [];
    const bundleUploads: Array<Record<string, unknown>> = [];
    return {
      serverFileUploads,
      bundleUploads,
      serverFileError: null as Error | null,
      async uploadServerFile(_p: string, _d: string, name: string, bytes: Uint8Array) {
        if (this.serverFileError) throw this.serverFileError;
        serverFileUploads.push({ name, bytes });
        return { ok: true };
      },
      async uploadDeploymentBundle(_p: string, _d: string, bundle: Record<string, unknown>) {
        bundleUploads.push(bundle);
        return { ok: true };
      },
    };
  }

  it("uploads each server file as binary and sends a slim bundle with serverFileNames", async () => {
    const client = mockClient();
    const bundle = {
      manifest: { hasWorker: true },
      assets: { "/a.js": "YQ==" },
      serverFiles: { "worker.js": Buffer.from("worker").toString("base64"), "q.wasm": Buffer.from("W").toString("base64") },
    };
    await stageDeploymentBundle(client, "p1", "d1", bundle);

    expect(client.serverFileUploads.map((u) => u.name)).toEqual(["worker.js", "q.wasm"]);
    expect(Buffer.from(client.serverFileUploads[0].bytes).toString()).toBe("worker");
    // The bundle sent to the server carries names, NOT the base64 server files.
    expect(client.bundleUploads).toHaveLength(1);
    const sent = client.bundleUploads[0];
    expect(sent.serverFileNames).toEqual(["worker.js", "q.wasm"]);
    expect(sent.serverFiles).toBeUndefined();
    expect(sent.assets).toEqual({ "/a.js": "YQ==" });
  });

  it("uploads the bundle directly when there are no server files (SPA)", async () => {
    const client = mockClient();
    await stageDeploymentBundle(client, "p1", "d1", { manifest: { hasWorker: false }, assets: { "/i.html": "PA==" } });
    expect(client.serverFileUploads).toHaveLength(0);
    expect(client.bundleUploads[0].serverFileNames).toBeUndefined();
  });

  it("falls back to the inline bundle when the server lacks the /serverfile route (404)", async () => {
    const client = mockClient();
    client.serverFileError = new CreekApiError(404, "not_found", "no route");
    const bundle = {
      manifest: { hasWorker: true },
      assets: {},
      serverFiles: { "worker.js": Buffer.from("w").toString("base64") },
    };
    await stageDeploymentBundle(client, "p1", "d1", bundle);

    // Server files couldn't be staged separately; the bundle keeps them inline.
    expect(client.bundleUploads).toHaveLength(1);
    expect(client.bundleUploads[0].serverFiles).toEqual(bundle.serverFiles);
    expect(client.bundleUploads[0].serverFileNames).toBeUndefined();
  });

  it("propagates a non-404 server-file upload error (no silent fallback)", async () => {
    const client = mockClient();
    client.serverFileError = new CreekApiError(500, "server_error", "boom");
    await expect(
      stageDeploymentBundle(client, "p1", "d1", {
        manifest: { hasWorker: true },
        assets: {},
        serverFiles: { "worker.js": "dw==" },
      }),
    ).rejects.toThrow(/boom/);
  });
});

describe("withTimeout (bounds best-effort drift detection)", () => {
  test("returns the resolved value when it beats the timeout", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "fallback")).resolves.toBe("ok");
  });

  test("returns the fallback and does not hang on a never-resolving promise", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<string>(() => {}); // never settles
      const p = withTimeout(never, 3000, "fallback");
      await vi.advanceTimersByTimeAsync(3000);
      await expect(p).resolves.toBe("fallback");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseWaitDuration (--wait)", () => {
  test("null for undefined (caller uses default) and unparseable input", () => {
    expect(parseWaitDuration(undefined)).toBeNull();
    expect(parseWaitDuration("soon")).toBeNull();
    expect(parseWaitDuration("15 minutes")).toBeNull();
  });

  test("parses suffixed durations", () => {
    expect(parseWaitDuration("900s")).toBe(900_000);
    expect(parseWaitDuration("15m")).toBe(900_000);
    expect(parseWaitDuration("1h")).toBe(3_600_000);
    expect(parseWaitDuration("300000")).toBe(300_000); // bare = ms
    expect(parseWaitDuration(" 15m ")).toBe(900_000); // trims
  });

  test("clamps to [1s, 60m] so a typo can't hang forever or bail instantly", () => {
    expect(parseWaitDuration("0")).toBe(1000);
    expect(parseWaitDuration("1ms")).toBe(1000);
    expect(parseWaitDuration("999h")).toBe(3_600_000);
  });
});

describe("makeProgress (deploy --json stdout hygiene)", () => {
  afterEach(() => vi.restoreAllMocks());

  test("in JSON mode every banner method is a no-op", () => {
    // Regression guard for the --json pollution bug: deploySandbox /
    // deployAuthenticated routed "[Detect]", "ℹ Mode: spa", "ℹ N assets"
    // etc. straight to stdout via section()/consola.*, breaking a
    // downstream JSON.parse. In JSON mode nothing but jsonOutput may write.
    const log = vi.spyOn(consola, "log").mockImplementation(() => {});
    const info = vi.spyOn(consola, "info").mockImplementation(() => {});
    const start = vi.spyOn(consola, "start").mockImplementation(() => {});
    const success = vi.spyOn(consola, "success").mockImplementation(() => {});
    const warn = vi.spyOn(consola, "warn").mockImplementation(() => {});

    const p = makeProgress(true);
    p.section("Detect");
    p.info("  Mode: spa");
    p.start("  Deploying...");
    p.success("  done");
    p.warn("  heads up");

    expect(log).not.toHaveBeenCalled(); // section() writes via consola.log
    expect(info).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test("in human mode banners are emitted", () => {
    const log = vi.spyOn(consola, "log").mockImplementation(() => {});
    const info = vi.spyOn(consola, "info").mockImplementation(() => {});
    const start = vi.spyOn(consola, "start").mockImplementation(() => {});
    const success = vi.spyOn(consola, "success").mockImplementation(() => {});
    const warn = vi.spyOn(consola, "warn").mockImplementation(() => {});

    const p = makeProgress(false);
    p.section("Detect");
    p.info("  Mode: spa");
    p.start("  Deploying...");
    p.success("  done");
    p.warn("  heads up");

    expect(log).toHaveBeenCalledTimes(1); // section()
    expect(info).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("sameOriginApiHint", () => {
  test("returns a hint only for worker+assets (single-origin) deploys", () => {
    const hint = sameOriginApiHint("worker", true);
    expect(hint).not.toBeNull();
    expect(hint).toContain("VITE_API_URL");
    expect(hint).toContain("relative");
  });

  test("is silent for spa, ssr, and worker-only deploys", () => {
    expect(sameOriginApiHint("spa", true)).toBeNull();
    expect(sameOriginApiHint("ssr", true)).toBeNull();
    // worker with no static assets isn't the SPA-same-origin footgun
    expect(sameOriginApiHint("worker", false)).toBeNull();
  });
});

describe("ephemeralSandboxDbWarning", () => {
  test("warns when the sandbox deploy has a database", () => {
    const warn = ephemeralSandboxDbWarning(true);
    expect(warn).not.toBeNull();
    expect(warn).toMatch(/ephemeral/i);
    expect(warn).toContain("creek login");
  });

  test("is silent when there is no database (no data to lose)", () => {
    expect(ephemeralSandboxDbWarning(false)).toBeNull();
  });
});

describe("resolveDeployEnv (production-safety gate)", () => {
  afterEach(() => vi.restoreAllMocks());

  const base = {
    authenticated: true,
    prod: false,
    sandbox: false,
    yes: false,
    jsonMode: false,
    projectName: "hivemind",
  };

  test("--sandbox always wins, even when signed in", async () => {
    expect(await resolveDeployEnv({ ...base, sandbox: true, interactive: true })).toBe("sandbox");
    // and even with --yes / non-interactive
    expect(await resolveDeployEnv({ ...base, sandbox: true, yes: true })).toBe("sandbox");
  });

  test("prod + sandbox together is rejected at the source of truth", async () => {
    await expect(resolveDeployEnv({ ...base, prod: true, sandbox: true })).rejects.toThrow(
      /mutually exclusive/,
    );
  });

  test("not signed in deploys to sandbox (the only option)", async () => {
    expect(await resolveDeployEnv({ ...base, authenticated: false })).toBe("sandbox");
  });

  test("--prod is explicit production intent, no prompt or warning", async () => {
    const warn = vi.spyOn(consola, "warn").mockImplementation(() => {});
    const prompt = vi.spyOn(consola, "prompt").mockResolvedValue(true as never);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(await resolveDeployEnv({ ...base, prod: true, interactive: true })).toBe("production");

    expect(prompt).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  test("signed in + interactive confirm: yes → production", async () => {
    const prompt = vi.spyOn(consola, "prompt").mockResolvedValue(true as never);
    expect(await resolveDeployEnv({ ...base, interactive: true })).toBe("production");
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt.mock.calls[0]?.[0]).toMatch(/PRODUCTION/);
  });

  test("signed in + interactive confirm: declined → abort", async () => {
    vi.spyOn(consola, "info").mockImplementation(() => {});
    vi.spyOn(consola, "prompt").mockResolvedValue(false as never);
    expect(await resolveDeployEnv({ ...base, interactive: true })).toBe("abort");
  });

  test("signed in + --yes (no --prod): production but deprecation-warns", async () => {
    const warn = vi.spyOn(consola, "warn").mockImplementation(() => {});
    expect(await resolveDeployEnv({ ...base, yes: true, interactive: true })).toBe("production");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/deprecation/i);
    expect(warn.mock.calls[0]?.[0]).toMatch(/--prod/);
  });

  test("signed in + --json (no --prod): production, deprecation to stderr (clean stdout)", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const warn = vi.spyOn(consola, "warn").mockImplementation(() => {});

    expect(await resolveDeployEnv({ ...base, jsonMode: true, interactive: true })).toBe(
      "production",
    );

    // warning goes to stderr, never consola (which could land on stdout)
    expect(stderr).toHaveBeenCalledOnce();
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/deprecation/i);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("CreekAuthError", () => {
  test("is thrown on 401 and has correct name", () => {
    const err = new CreekAuthError("Token expired");
    expect(err.name).toBe("CreekAuthError");
    expect(err.message).toBe("Token expired");
    expect(err instanceof Error).toBe(true);
  });

  test("can be distinguished from CreekApiError", () => {
    const authErr = new CreekAuthError("Unauthorized");
    const apiErr = new CreekApiError(500, "server_error", "Internal error");

    expect(authErr instanceof CreekAuthError).toBe(true);
    expect(authErr instanceof CreekApiError).toBe(false);
    expect(apiErr instanceof CreekApiError).toBe(true);
    expect(apiErr instanceof CreekAuthError).toBe(false);
  });
});

describe("deploy polling constants", () => {
  test("TERMINAL states include active, failed, cancelled", () => {
    // These are the states that should stop CLI polling
    const TERMINAL = new Set(["active", "failed", "cancelled"]);
    expect(TERMINAL.has("active")).toBe(true);
    expect(TERMINAL.has("failed")).toBe(true);
    expect(TERMINAL.has("cancelled")).toBe(true);
    expect(TERMINAL.has("deploying")).toBe(false);
    expect(TERMINAL.has("queued")).toBe(false);
  });

  test("all deploy statuses have labels", () => {
    const STEP_LABELS: Record<string, string> = {
      queued: "Waiting...",
      uploading: "Uploading bundle...",
      provisioning: "Provisioning resources...",
      deploying: "Deploying to edge...",
    };

    // Every non-terminal status should have a label
    for (const status of ["queued", "uploading", "provisioning", "deploying"]) {
      expect(STEP_LABELS[status]).toBeDefined();
      expect(STEP_LABELS[status].length).toBeGreaterThan(0);
    }
  });
});

describe("patchBareNodeImports", () => {
  test("adds node: prefix to bare ESM imports", () => {
    const code = 'import fs from "fs";\nimport path from "path";';
    const result = patchBareNodeImports(code);
    expect(result).toContain('from "node:fs"');
    expect(result).toContain('from "node:path"');
  });

  test("adds node: prefix to bare require calls", () => {
    const code = 'const fs = require("fs");\nconst http = require("http");';
    const result = patchBareNodeImports(code);
    expect(result).toContain('require("node:fs")');
    expect(result).toContain('require("node:http")');
  });

  test("does not modify already-prefixed imports", () => {
    const code = 'import fs from "node:fs";';
    const result = patchBareNodeImports(code);
    expect(result).toBe(code);
  });

  test("does not modify non-builtin imports", () => {
    const code = 'import hono from "hono";\nimport react from "react";';
    const result = patchBareNodeImports(code);
    expect(result).toBe(code);
  });

  test("handles worker_threads", () => {
    const code = 'import libDefault from "worker_threads";';
    const result = patchBareNodeImports(code);
    expect(result).toContain('from "node:worker_threads"');
  });

  test("handles mixed bare and prefixed imports", () => {
    const code = 'import a from "fs";\nimport b from "node:path";\nimport c from "stream";';
    const result = patchBareNodeImports(code);
    expect(result).toContain('from "node:fs"');
    expect(result).toContain('from "node:path"');
    expect(result).toContain('from "node:stream"');
  });

  test("preserves non-import code", () => {
    const code = 'const x = "fs is great";\nimport fs from "fs";';
    const result = patchBareNodeImports(code);
    expect(result).toContain('const x = "fs is great"');
    expect(result).toContain('from "node:fs"');
  });
});

// ============================================================================
// --from-github helpers
// ============================================================================

function d(id: string, createdAt: number, status = "queued"): CliDeployment {
  return {
    id,
    version: 0,
    status,
    branch: "main",
    failedStep: null,
    errorMessage: null,
    createdAt,
    url: null,
  };
}

describe("findNewDeployment", () => {
  test("returns null when no deployment is newer than snapshot", () => {
    const list = [d("a", 100), d("b", 200), d("c", 300)];
    expect(findNewDeployment(list, 300)).toBeNull();
    expect(findNewDeployment(list, 999)).toBeNull();
  });

  test("returns null on an empty list", () => {
    expect(findNewDeployment([], 0)).toBeNull();
  });

  test("returns the only new deployment when exactly one is newer", () => {
    const list = [d("old", 100), d("new", 500)];
    const found = findNewDeployment(list, 200);
    expect(found?.id).toBe("new");
  });

  test("returns the most recently created when multiple are newer", () => {
    // API returns unsorted (or version-sorted) list; the helper must pick
    // the newest by createdAt, not by list position.
    const list = [d("mid", 300), d("newest", 500), d("old", 100), d("newer", 400)];
    const found = findNewDeployment(list, 200);
    expect(found?.id).toBe("newest");
  });

  test("treats the snapshot threshold as strictly greater-than", () => {
    // A deployment with createdAt EXACTLY equal to the snapshot is the one
    // we snapshotted — don't treat it as a new row.
    const list = [d("snapshot", 200), d("new", 201)];
    const found = findNewDeployment(list, 200);
    expect(found?.id).toBe("new");
  });
});

describe("CLI status sets", () => {
  test("terminal statuses do not overlap with in-flight statuses", () => {
    for (const s of CLI_TERMINAL_STATUSES) {
      expect(CLI_IN_FLIGHT_STATUSES.has(s)).toBe(false);
    }
    for (const s of CLI_IN_FLIGHT_STATUSES) {
      expect(CLI_TERMINAL_STATUSES.has(s)).toBe(false);
    }
  });

  test("terminal set covers the three settled states", () => {
    expect(CLI_TERMINAL_STATUSES.has("active")).toBe(true);
    expect(CLI_TERMINAL_STATUSES.has("failed")).toBe(true);
    expect(CLI_TERMINAL_STATUSES.has("cancelled")).toBe(true);
  });

  test("in-flight set covers the progression from queued through deploying", () => {
    expect(CLI_IN_FLIGHT_STATUSES.has("queued")).toBe(true);
    expect(CLI_IN_FLIGHT_STATUSES.has("uploading")).toBe(true);
    expect(CLI_IN_FLIGHT_STATUSES.has("provisioning")).toBe(true);
    expect(CLI_IN_FLIGHT_STATUSES.has("deploying")).toBe(true);
  });
});
