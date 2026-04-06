// Worker execution for `creek dev` — bundles user code and runs it via Miniflare.
//
// Uses esbuild watch mode for hot reload and Miniflare for D1/KV/R2 simulation.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { context, type BuildContext } from "esbuild";
import { Miniflare } from "miniflare";
import { generateWorkerWrapper } from "../utils/worker-bundle.js";
import type { BindingDeclaration } from "@solcreek/sdk";

const NODE_BUILTINS = [
  "node:async_hooks",
  "node:stream",
  "node:stream/web",
  "node:buffer",
  "node:util",
  "node:events",
  "node:crypto",
  "node:path",
  "node:url",
  "node:string_decoder",
  "node:diagnostics_channel",
  "node:process",
  "node:fs",
  "node:os",
  "node:child_process",
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "node:zlib",
  "node:perf_hooks",
  "node:worker_threads",
];

export interface WorkerRunnerOptions {
  /** User's worker entry point (e.g. "worker/index.ts"). */
  entryPoint: string;
  /** Project root directory. */
  cwd: string;
  /** Declared bindings from creek.toml / wrangler config. */
  bindings: BindingDeclaration[];
  /** Persistence directory for D1/KV/R2 data. */
  persistDir: string;
  /** Local realtime server URL (e.g. "http://localhost:8788"). */
  realtimeUrl: string;
  /** Project slug (e.g. "realtime-todos"). */
  projectSlug: string;
  /** User-defined environment variables from config. */
  vars?: Record<string, string>;
  /** Whether the project has client assets (Worker + SPA hybrid). */
  hasClientAssets?: boolean;
  /** Callback when worker is rebuilt. */
  onRebuild?: (durationMs: number) => void;
  /**
   * Additional node module resolution paths for esbuild.
   * @internal — used by tests to resolve `creek` from monorepo.
   */
  nodePaths?: string[];
}

export class WorkerRunner {
  private mf: Miniflare | null = null;
  private esbuildCtx: BuildContext | null = null;
  private options: WorkerRunnerOptions;
  private mfOptions: Record<string, unknown> = {};
  private port = 0;

  constructor(options: WorkerRunnerOptions) {
    this.options = options;
  }

  async start(): Promise<{ port: number }> {
    const { cwd, entryPoint, persistDir } = this.options;

    // 1. Generate worker wrapper
    const wrapperDir = join(cwd, ".creek", "dev");
    mkdirSync(wrapperDir, { recursive: true });

    const entryAbsolute = resolve(cwd, entryPoint);
    const wrapper = generateWorkerWrapper(entryAbsolute, wrapperDir, {
      hasClientAssets: this.options.hasClientAssets,
    });
    const wrapperPath = join(wrapperDir, "__worker_entry.js");
    writeFileSync(wrapperPath, wrapper);

    // 2. Initial bundle with esbuild
    const bundledScript = await this.bundle(wrapperPath);

    // 3. Start Miniflare
    this.mfOptions = this.buildMiniflareOptions(bundledScript, persistDir);
    this.mf = new Miniflare(this.mfOptions as any);

    // Wait for Miniflare to be ready and get the port
    const readyUrl = await this.mf.ready;
    // mf.ready returns a URL object
    this.port = readyUrl.port ? parseInt(String(readyUrl.port), 10) : 8787;

    // 4. Start esbuild watch mode for hot reload
    await this.startWatching(wrapperPath);

    return { port: this.port };
  }

  async stop(): Promise<void> {
    if (this.esbuildCtx) {
      await this.esbuildCtx.dispose();
      this.esbuildCtx = null;
    }
    if (this.mf) {
      await this.mf.dispose();
      this.mf = null;
    }
  }

  /** Get the URL the worker is running on. */
  getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Get the port the worker is running on. */
  getPort(): number {
    return this.port;
  }

  /** Dispatch a fetch request to the worker (via Miniflare). */
  async dispatchFetch(
    input: string,
    init?: RequestInit,
  ): Promise<Response> {
    if (!this.mf) throw new Error("WorkerRunner not started");
    return this.mf.dispatchFetch(input, init as any) as unknown as Response;
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private buildMiniflareOptions(
    script: string,
    persistDir: string,
  ): Record<string, unknown> {
    const { bindings, projectSlug, realtimeUrl, vars } = this.options;

    const hasD1 = bindings.some((b) => b.type === "d1");
    const hasKV = bindings.some((b) => b.type === "kv");
    const hasR2 = bindings.some((b) => b.type === "r2");

    const d1BindingName =
      bindings.find((b) => b.type === "d1")?.name ?? "DB";
    const kvBindingName =
      bindings.find((b) => b.type === "kv")?.name ?? "KV";
    const r2BindingName =
      bindings.find((b) => b.type === "r2")?.name ?? "STORAGE";

    const opts: Record<string, unknown> = {
      modules: true,
      script,
      compatibilityDate: "2024-12-01",
      compatibilityFlags: ["nodejs_compat"],

      // Environment variables
      bindings: {
        CREEK_PROJECT_SLUG: projectSlug,
        CREEK_REALTIME_URL: realtimeUrl,
        // CREEK_REALTIME_SECRET intentionally omitted (dev mode = no auth)
        ...vars,
      },
    };

    // D1 — SQLite-backed
    if (hasD1) {
      opts.d1Databases = { [d1BindingName]: "creek-dev-db" };
      opts.d1Persist = persistDir ? join(persistDir, "d1") : false;
    }

    // KV
    if (hasKV) {
      opts.kvNamespaces = { [kvBindingName]: "creek-dev-kv" };
      opts.kvPersist = persistDir ? join(persistDir, "kv") : false;
    }

    // R2
    if (hasR2) {
      opts.r2Buckets = { [r2BindingName]: "creek-dev-r2" };
      opts.r2Persist = persistDir ? join(persistDir, "r2") : false;
    }

    return opts;
  }

  private get esbuildOptions() {
    return {
      absWorkingDir: this.options.cwd,
      bundle: true as const,
      format: "esm" as const,
      platform: "neutral" as const,
      target: "es2022",
      write: false as const,
      minify: false,
      external: NODE_BUILTINS,
      conditions: ["workerd", "worker", "import"],
      mainFields: ["module", "main"],
      logLevel: "warning" as const,
      ...(this.options.nodePaths?.length
        ? { nodePaths: this.options.nodePaths }
        : {}),
    };
  }

  private async bundle(entryPoint: string): Promise<string> {
    const result = await import("esbuild").then((esbuild) =>
      esbuild.build({
        entryPoints: [entryPoint],
        ...this.esbuildOptions,
      }),
    );

    if (result.errors.length > 0) {
      throw new Error(
        `esbuild: ${result.errors.map((e) => e.text).join(", ")}`,
      );
    }

    return result.outputFiles[0].text;
  }

  private async startWatching(entryPoint: string): Promise<void> {
    this.esbuildCtx = await context({
      entryPoints: [entryPoint],
      ...this.esbuildOptions,
      plugins: [
        {
          name: "creek-hot-reload",
          setup: (build) => {
            build.onEnd(async (result) => {
              if (result.errors.length > 0 || !result.outputFiles?.length) {
                return;
              }
              const start = Date.now();
              const newScript = result.outputFiles[0].text;
              try {
                await this.mf?.setOptions({
                  ...this.mfOptions,
                  script: newScript,
                } as any);
                this.options.onRebuild?.(Date.now() - start);
              } catch {
                // Reload failed — keep running with old version
              }
            });
          },
        },
      ],
    });

    await this.esbuildCtx.watch();
  }
}

/**
 * Build Miniflare options from bindings — extracted for testing.
 * @internal
 */
export function buildMiniflareBindingOptions(
  bindings: BindingDeclaration[],
): {
  hasD1: boolean;
  hasKV: boolean;
  hasR2: boolean;
  d1BindingName: string;
  kvBindingName: string;
  r2BindingName: string;
} {
  return {
    hasD1: bindings.some((b) => b.type === "d1"),
    hasKV: bindings.some((b) => b.type === "kv"),
    hasR2: bindings.some((b) => b.type === "r2"),
    d1BindingName: bindings.find((b) => b.type === "d1")?.name ?? "DB",
    kvBindingName: bindings.find((b) => b.type === "kv")?.name ?? "KV",
    r2BindingName: bindings.find((b) => b.type === "r2")?.name ?? "STORAGE",
  };
}
