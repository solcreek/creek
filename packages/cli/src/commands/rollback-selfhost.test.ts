import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollbackCommand } from "./rollback.js";
import { writeHosts, HOSTS_SCHEMA_VERSION } from "../utils/hosts.js";
import { writeLocalCache, recordLastDeploy, LOCAL_SCHEMA_VERSION } from "../utils/local-cache.js";

/**
 * Self-host rollback is tested by driving the citty command's
 * .run() directly with a fully sandboxed environment:
 *   - CREEK_HOSTS_PATH points at a tmp hosts.json with a pinned host
 *   - The project's .creek/local.json has a stale or fresh rv
 *   - globalThis.fetch is a programmable mock that captures every
 *     request and decides the response per-test
 *   - process.exit is stubbed so the assertion fires on the exit
 *     code rather than tearing down vitest
 */

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface MockedFetch {
  fn: typeof fetch;
  calls: FetchCall[];
  /** Queue of responses — each fetch consumes one entry. */
  queue: Array<{ status: number; body: unknown }>;
}

function makeFetch(queue: Array<{ status: number; body: unknown }>): MockedFetch {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = queue.shift();
    if (!r) throw new Error(`fetch queue empty for ${url}`);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: "OK",
      json: () => Promise.resolve(r.body),
      text: () => Promise.resolve(typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    } as unknown as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls, queue };
}

interface TestEnv {
  project: string;
  hostsPath: string;
  originalFetch: typeof fetch;
  originalCwd: () => string;
  exitCalls: number[];
}

function setup(): TestEnv {
  const project = join(tmpdir(), "creek-rb-test-" + Math.random().toString(36).slice(2));
  mkdirSync(project, { recursive: true });
  // creek.toml with project.name = "myapp"
  writeFileSync(join(project, "creek.toml"), `[project]\nname = "myapp"\n`);
  // Pin a host into a per-test hosts.json.
  const hostsPath = join(project, "hosts.json");
  process.env.CREEK_HOSTS_PATH = hostsPath;
  writeHosts(
    {
      schemaVersion: HOSTS_SCHEMA_VERSION,
      hosts: [
        {
          name: "prod",
          addr: "127.0.0.1:9080",
          creekdPubkey: "PK",
          fingerprint: "sha256:" + "a".repeat(64),
          lastSeen: "2026-05-24T00:00:00Z",
        },
      ],
    },
    hostsPath,
  );
  const originalCwd = process.cwd;
  process.cwd = () => project;
  const originalFetch = globalThis.fetch;
  const exitCalls: number[] = [];
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCalls.push(code ?? 0);
    throw new ProcessExitError(code ?? 0);
  }) as never);
  return { project, hostsPath, originalFetch, originalCwd, exitCalls };
}

function teardown(env: TestEnv) {
  globalThis.fetch = env.originalFetch;
  process.cwd = env.originalCwd;
  rmSync(env.project, { recursive: true, force: true });
  delete process.env.CREEK_HOSTS_PATH;
  vi.restoreAllMocks();
}

/** Sentinel thrown by the process.exit stub so the test can catch it. */
class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

async function runRollback(args: Record<string, unknown>): Promise<void> {
  // citty's defineCommand has .run on the returned object.
  // Cast to access — internal API but stable in the @0.4.21 line.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = rollbackCommand as any;
  try {
    await cmd.run({ args, cmd: cmd.command, rawArgs: [] });
  } catch (e) {
    if (!(e instanceof ProcessExitError)) throw e;
  }
}

describe("rollback --host (self-host)", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  it("happy path: posts /rollback?to=N with cached If-Match + records new rv", async () => {
    // Seed local.json with cached rv so the flow uses it (no GET
    // probe before the rollback).
    recordLastDeploy(env.project, {
      appId: "myapp",
      host: "prod",
      resourceVersion: "5",
      generation: 1,
      at: "2026-05-24T00:00:00Z",
    });

    const mocked = makeFetch([
      // POST /v1/apps/myapp/rollback?to=2
      {
        status: 200,
        body: {
          uid: "rel-uid",
          phase: "Active",
          creationTimestamp: "2026-05-24T01:00:00Z",
          spec: { appUid: "app-uid", releaseSeq: 3, rolledBackFrom: 2, originalArtifactRelease: 2 },
        },
      },
      // GET /v1/apps/myapp (cache refresh)
      {
        status: 200,
        body: {
          apiVersion: "creek.dev/v1alpha1",
          kind: "App",
          metadata: {
            name: "myapp",
            uid: "u",
            generation: 1,
            resourceVersion: "6",
            creationTimestamp: "t",
          },
          spec: {},
          status: {
            observedGeneration: 1,
            conditions: [],
            currentPid: 0,
            currentPort: 0,
            restartCount: 0,
            healthFailures: 0,
            uptimeMs: 0,
          },
        },
      },
    ]);
    globalThis.fetch = mocked.fn;

    await runRollback({ host: "prod", to: "2", json: true });

    // First call: POST /rollback with If-Match: 5.
    expect(mocked.calls[0]?.url).toBe("http://127.0.0.1:9080/v1/apps/myapp/rollback?to=2");
    const h0 = (mocked.calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(h0["If-Match"]).toBe("5");
    // Second call: GET to refresh the local cache.
    expect(mocked.calls[1]?.url).toBe("http://127.0.0.1:9080/v1/apps/myapp");

    // Cache updated to the post-rollback rv.
    const cachePath = join(env.project, ".creek", "local.json");
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.lastDeploy.resourceVersion).toBe("6");
  });

  it("falls back to fresh GET when local cache empty", async () => {
    // No recordLastDeploy — cache is empty.
    const mocked = makeFetch([
      // GET /v1/apps/myapp (probe for fresh rv before rollback)
      {
        status: 200,
        body: {
          apiVersion: "creek.dev/v1alpha1",
          kind: "App",
          metadata: {
            name: "myapp",
            uid: "u",
            generation: 1,
            resourceVersion: "9",
            creationTimestamp: "t",
          },
          spec: {},
          status: {
            observedGeneration: 1,
            conditions: [],
            currentPid: 0,
            currentPort: 0,
            restartCount: 0,
            healthFailures: 0,
            uptimeMs: 0,
          },
        },
      },
      // POST /rollback with If-Match: 9
      {
        status: 200,
        body: {
          uid: "rel-uid",
          phase: "Active",
          creationTimestamp: "2026-05-24T01:00:00Z",
          spec: { appUid: "app-uid", releaseSeq: 4, rolledBackFrom: 1, originalArtifactRelease: 1 },
        },
      },
      // GET (cache refresh)
      {
        status: 200,
        body: {
          apiVersion: "creek.dev/v1alpha1",
          kind: "App",
          metadata: {
            name: "myapp",
            uid: "u",
            generation: 1,
            resourceVersion: "10",
            creationTimestamp: "t",
          },
          spec: {},
          status: {
            observedGeneration: 1,
            conditions: [],
            currentPid: 0,
            currentPort: 0,
            restartCount: 0,
            healthFailures: 0,
            uptimeMs: 0,
          },
        },
      },
    ]);
    globalThis.fetch = mocked.fn;

    await runRollback({ host: "prod", to: "1", json: true });

    // First call: probe GET.
    expect(mocked.calls[0]?.url).toBe("http://127.0.0.1:9080/v1/apps/myapp");
    expect(mocked.calls[0]?.init?.method).toBe("GET");
    // Second call: rollback POST with If-Match=9 from probe.
    expect(mocked.calls[1]?.init?.method).toBe("POST");
    const h1 = (mocked.calls[1]?.init?.headers ?? {}) as Record<string, string>;
    expect(h1["If-Match"]).toBe("9");
  });

  it("412 without --bypass-rv surfaces structured error + does NOT retry", async () => {
    recordLastDeploy(env.project, {
      appId: "myapp",
      host: "prod",
      resourceVersion: "3",
      generation: 1,
      at: "2026-05-24T00:00:00Z",
    });
    const mocked = makeFetch([
      // POST /rollback → 412
      {
        status: 412,
        body: { code: "resource_version_mismatch", error: "drift", currentResourceVersion: "5" },
      },
    ]);
    globalThis.fetch = mocked.fn;

    await runRollback({ host: "prod", to: "2", json: true });

    // Exactly ONE fetch — no auto-retry.
    expect(mocked.calls).toHaveLength(1);
    // Process exited with non-zero — error code surfaced.
    expect(env.exitCalls).toEqual([1]);
  });

  it("412 WITH --bypass-rv re-fetches and retries exactly once", async () => {
    recordLastDeploy(env.project, {
      appId: "myapp",
      host: "prod",
      resourceVersion: "3",
      generation: 1,
      at: "2026-05-24T00:00:00Z",
    });
    const mocked = makeFetch([
      // POST /rollback → 412
      {
        status: 412,
        body: { code: "resource_version_mismatch", error: "drift", currentResourceVersion: "8" },
      },
      // GET probe for fresh rv
      {
        status: 200,
        body: {
          apiVersion: "creek.dev/v1alpha1",
          kind: "App",
          metadata: {
            name: "myapp",
            uid: "u",
            generation: 1,
            resourceVersion: "8",
            creationTimestamp: "t",
          },
          spec: {},
          status: {
            observedGeneration: 1,
            conditions: [],
            currentPid: 0,
            currentPort: 0,
            restartCount: 0,
            healthFailures: 0,
            uptimeMs: 0,
          },
        },
      },
      // Retry POST /rollback with If-Match: 8
      {
        status: 200,
        body: {
          uid: "rel-uid",
          phase: "Active",
          creationTimestamp: "2026-05-24T01:00:00Z",
          spec: { appUid: "u", releaseSeq: 9, rolledBackFrom: 2, originalArtifactRelease: 2 },
        },
      },
      // Final GET (cache refresh)
      {
        status: 200,
        body: {
          apiVersion: "creek.dev/v1alpha1",
          kind: "App",
          metadata: {
            name: "myapp",
            uid: "u",
            generation: 1,
            resourceVersion: "9",
            creationTimestamp: "t",
          },
          spec: {},
          status: {
            observedGeneration: 1,
            conditions: [],
            currentPid: 0,
            currentPort: 0,
            restartCount: 0,
            healthFailures: 0,
            uptimeMs: 0,
          },
        },
      },
    ]);
    globalThis.fetch = mocked.fn;

    await runRollback({ host: "prod", to: "2", "bypass-rv": true, json: true });

    expect(env.exitCalls).toEqual([0]); // jsonOutput(_, 0, _) is "ok" exit
    // Calls: initial-412 → probe-200 → retry-200 → final-200.
    expect(mocked.calls.length).toBeGreaterThanOrEqual(3);
    const retry = mocked.calls[2];
    expect(retry?.init?.method).toBe("POST");
    const headers = (retry?.init?.headers ?? {}) as Record<string, string>;
    expect(headers["If-Match"]).toBe("8");
  });

  it("rejects --host pointing at an unknown name", async () => {
    await runRollback({ host: "ghost", to: "1", json: true });
    expect(env.exitCalls).toEqual([1]);
  });

  it("rejects missing --to", async () => {
    await runRollback({ host: "prod", json: true });
    expect(env.exitCalls).toEqual([1]);
  });

  it("rejects non-numeric --to", async () => {
    await runRollback({ host: "prod", to: "notanumber", json: true });
    expect(env.exitCalls).toEqual([1]);
  });

  it("rejects --to without --host (would otherwise mis-route to CF Workers)", async () => {
    // Restore real local cwd so the CF path isn't reached either.
    await runRollback({ to: "1", json: true });
    expect(env.exitCalls).toEqual([1]);
  });

  it("writes hosts.json absent → fails with host_not_pinned", async () => {
    // Wipe hosts.json the setup wrote.
    rmSync(env.hostsPath, { force: true });
    await runRollback({ host: "prod", to: "1", json: true });
    expect(env.exitCalls).toEqual([1]);
  });
});
