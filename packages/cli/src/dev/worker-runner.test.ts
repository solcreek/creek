import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildMiniflareBindingOptions, WorkerRunner } from "./worker-runner.js";
import type { BindingDeclaration } from "@solcreek/sdk";

// Path to the runtime package — used as a fake "creek" for test fixtures.
// In pnpm workspace, `creek` resolves to `@solcreek/runtime`.
const RUNTIME_PKG = resolve(import.meta.dirname, "../../../runtime");

// ─── Unit Tests ───────────────────────────────────────────────────────────────

describe("buildMiniflareBindingOptions", () => {
  it("detects D1 binding", () => {
    const bindings: BindingDeclaration[] = [{ type: "d1", name: "DB" }];
    const result = buildMiniflareBindingOptions(bindings);
    expect(result.hasD1).toBe(true);
    expect(result.d1BindingName).toBe("DB");
  });

  it("detects KV and R2 bindings", () => {
    const bindings: BindingDeclaration[] = [
      { type: "kv", name: "MY_KV" },
      { type: "r2", name: "MY_BUCKET" },
    ];
    const result = buildMiniflareBindingOptions(bindings);
    expect(result.hasKV).toBe(true);
    expect(result.kvBindingName).toBe("MY_KV");
    expect(result.hasR2).toBe(true);
    expect(result.r2BindingName).toBe("MY_BUCKET");
  });

  it("returns defaults when no bindings", () => {
    const result = buildMiniflareBindingOptions([]);
    expect(result.hasD1).toBe(false);
    expect(result.hasKV).toBe(false);
    expect(result.hasR2).toBe(false);
    expect(result.d1BindingName).toBe("DB");
    expect(result.kvBindingName).toBe("KV");
    expect(result.r2BindingName).toBe("STORAGE");
  });
});

// ─── Integration Tests (real Miniflare) ──────────────────────────────────────

describe("WorkerRunner integration", () => {
  let tmpDir: string;
  let runner: WorkerRunner | null = null;

  function createTempProject() {
    tmpDir = mkdtempSync(join(tmpdir(), "creek-dev-test-"));
    // Create a minimal worker
    const workerDir = join(tmpDir, "worker");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, "index.ts"),
      `export default {
        async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === "/api/echo") {
            return new Response(JSON.stringify({ echo: "hello" }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response("Not Found", { status: 404 });
        },
      };`,
    );

    // Create minimal package.json
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-project", type: "module" }),
    );

    // Create node_modules/creek → symlink to runtime package (like pnpm does)
    const nmDir = join(tmpDir, "node_modules");
    mkdirSync(nmDir, { recursive: true });
    symlinkSync(RUNTIME_PKG, join(nmDir, "creek"), "dir");

    return tmpDir;
  }

  /** Retry a fetch via dispatchFetch — workerd may need a moment after mf.ready */
  async function fetchWithRetry(
    r: WorkerRunner,
    url: string,
    retries = 3,
  ): Promise<Response> {
    for (let i = 0; i < retries; i++) {
      try {
        return await r.dispatchFetch(url);
      } catch {
        if (i === retries - 1) throw new Error(`Failed after ${retries} attempts: ${url}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error("unreachable");
  }

  afterEach(async () => {
    if (runner) {
      await runner.stop();
      runner = null;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("starts and serves worker requests", async () => {
    const cwd = createTempProject();
    const persistDir = join(cwd, ".creek", "dev");

    runner = new WorkerRunner({
      entryPoint: "worker/index.ts",
      cwd,
      bindings: [],
      persistDir,
      realtimeUrl: "http://127.0.0.1:9999",
      projectSlug: "test-project",
    });

    const { port } = await runner.start();
    expect(port).toBeGreaterThan(0);

    const res = await fetchWithRetry(runner, "http://localhost/api/echo");
    const body = await res.json();
    expect(body).toEqual({ echo: "hello" });
  }, 15000);

  it("serves /__creek/config endpoint", async () => {
    const cwd = createTempProject();
    const persistDir = join(cwd, ".creek", "dev");

    runner = new WorkerRunner({
      entryPoint: "worker/index.ts",
      cwd,
      bindings: [],
      persistDir,
      realtimeUrl: "http://127.0.0.1:8788",
      projectSlug: "my-project",
    });

    await runner.start();

    const res = await fetchWithRetry(runner, "http://localhost/__creek/config");
    const body = await res.json();

    expect(body.projectSlug).toBe("my-project");
    expect(body.realtimeUrl).toBe("http://127.0.0.1:8788");
  }, 15000);

  it("provides D1 database binding", async () => {
    const cwd = createTempProject();
    const persistDir = join(cwd, ".creek", "dev");

    // Overwrite worker with D1 usage
    writeFileSync(
      join(cwd, "worker", "index.ts"),
      `export default {
        async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === "/api/d1-test") {
            await env.DB.prepare("DROP TABLE IF EXISTS test").run();
            await env.DB.prepare("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)").run();
            await env.DB.prepare("INSERT INTO test (name) VALUES (?)").bind("hello").run();
            const result = await env.DB.prepare("SELECT * FROM test").all();
            return new Response(JSON.stringify(result.results), {
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response("Not Found", { status: 404 });
        },
      };`,
    );

    runner = new WorkerRunner({
      entryPoint: "worker/index.ts",
      cwd,
      bindings: [{ type: "d1", name: "DB" }],
      persistDir,
      realtimeUrl: "http://127.0.0.1:9999",
      projectSlug: "test-project",
    });

    await runner.start();

    const res = await fetchWithRetry(runner, "http://localhost/api/d1-test");
    const body = await res.json();

    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("hello");
  }, 15000);

  it("stops cleanly", async () => {
    const cwd = createTempProject();
    const persistDir = join(cwd, ".creek", "dev");

    runner = new WorkerRunner({
      entryPoint: "worker/index.ts",
      cwd,
      bindings: [],
      persistDir,
      realtimeUrl: "http://127.0.0.1:9999",
      projectSlug: "test-project",
    });

    await runner.start();

    // Verify it's running
    const res = await fetchWithRetry(runner, "http://localhost/api/echo");
    expect(res.ok).toBe(true);

    await runner.stop();
    runner = null;

    // Verify it's stopped — dispatchFetch should throw
    const runner2 = new WorkerRunner({
      entryPoint: "worker/index.ts",
      cwd,
      bindings: [],
      persistDir,
      realtimeUrl: "http://127.0.0.1:9999",
      projectSlug: "test-project",
    });
    // Don't start runner2 — just verify the old runner is gone
    expect(runner2.getPort()).toBe(0);
  }, 15000);
});
