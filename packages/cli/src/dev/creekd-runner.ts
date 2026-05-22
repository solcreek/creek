// CreekdDevServer for `creek dev --target creekd`.
//
// Orchestrates `creekd sandbox` (Go binary) instead of Miniflare.
// Real Postgres, Redis, SeaweedFS run inside a Lima VM.
// The app process runs inside the VM with env vars injected.
//
// Requirements:
//   - `creekd` binary in PATH
//   - Lima (`limactl`) for macOS/Linux sandbox VM

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
import type { ResolvedConfig } from "@solcreek/sdk";

export interface CreekdDevServerOptions {
  cwd: string;
  port: number;
  config: ResolvedConfig;
  reset: boolean;
}

interface SandboxStatus {
  vm: string;
  status: string;
  primitives: string[];
  ports: { name: string; guest: number; host: number }[];
}

export class CreekdDevServer {
  private options: CreekdDevServerOptions;
  private sandboxProcess: ChildProcess | null = null;

  constructor(options: CreekdDevServerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const { cwd, port, config, reset } = this.options;
    const startTime = Date.now();

    // 1. Check creekd is installed
    this.requireCreekd();

    // 2. Start sandbox (provisions Lima VM + primitives from creek.toml)
    consola.info("Starting creekd sandbox...");
    const status = await this.ensureSandbox(cwd);

    // 3. Build env var map from sandbox primitives
    const env = this.buildEnvVars(config, status, port);

    // 4. Load .env.local if present
    const envLocalPath = join(cwd, ".env.local");
    if (existsSync(envLocalPath)) {
      const { readFileSync } = await import("node:fs");
      const lines = readFileSync(envLocalPath, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx);
          const val = trimmed.slice(eqIdx + 1).replace(/^["']|["']$/g, "");
          if (!env[key]) env[key] = val;
        }
      }
      consola.info(`.env.local loaded`);
    }

    // 5. Detect runtime and dev command
    const devCmd = this.detectDevCommand(cwd, config);

    // 6. Print status
    const elapsed = Date.now() - startTime;
    console.log("");
    consola.success("⬡ creek dev (creekd sandbox)\n");
    consola.info(`App:        http://localhost:${port}`);
    for (const p of status.ports) {
      if (p.name !== "app") {
        consola.info(`${p.name.padEnd(12)}localhost:${p.host}`);
      }
    }
    console.log("");
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith("DATABASE") || k.startsWith("REDIS") || k.startsWith("S3_") || k.startsWith("SMTP")) {
        const masked = v.replace(/:[^:@]+@/, ":***@");
        consola.info(`  ${k}=${masked}`);
      }
    }
    console.log("");
    consola.info(`Running: ${devCmd.join(" ")}`);
    consola.info(`Ready in ${elapsed}ms`);
    console.log("");

    // 7. Start the dev server process with env vars
    this.sandboxProcess = spawn(devCmd[0], devCmd.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });

    this.sandboxProcess.on("exit", (code) => {
      if (code !== null && code !== 0) {
        consola.error(`Dev server exited with code ${code}`);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.sandboxProcess) {
      this.sandboxProcess.kill("SIGTERM");
      this.sandboxProcess = null;
    }
    // Don't stop the sandbox VM — it persists for fast restarts
  }

  // --- Internals ---

  private requireCreekd(): void {
    try {
      execSync("creekd --version", { stdio: "pipe" });
    } catch {
      throw new Error(
        [
          "creekd is not installed.",
          "",
          "  Install with: curl -fsSL https://install.creek.dev | sh",
          "",
          "  Or use --target cf to develop with Miniflare (CF Workers local).",
        ].join("\n"),
      );
    }
  }

  private async ensureSandbox(cwd: string): Promise<SandboxStatus> {
    try {
      const output = execSync(
        `creekd sandbox --non-interactive --json "${cwd}"`,
        { encoding: "utf-8", timeout: 300_000 },
      );
      // Find the JSON line in output (creekd may print logs before JSON)
      const lines = output.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          return JSON.parse(lines[i]) as SandboxStatus;
        } catch {
          continue;
        }
      }
      throw new Error("No JSON status from creekd sandbox");
    } catch (e: any) {
      if (e.message?.includes("not installed")) throw e;
      throw new Error(`creekd sandbox failed: ${e.message}`);
    }
  }

  private buildEnvVars(
    config: ResolvedConfig,
    status: SandboxStatus,
    port: number,
  ): Record<string, string> {
    const env: Record<string, string> = {
      PORT: String(port),
    };

    // Map sandbox ports to standard env vars
    for (const p of status.ports) {
      switch (p.name) {
        case "postgres":
          env.DATABASE_URL = `postgresql://creek:creek_sandbox@127.0.0.1:${p.host}/app`;
          break;
        case "mysql":
          env.DATABASE_URL = `mysql://creek:creek_sandbox@127.0.0.1:${p.host}/app`;
          break;
        case "redis":
          env.REDIS_URL = `redis://127.0.0.1:${p.host}/0`;
          break;
        case "s3":
          env.S3_ENDPOINT = `http://127.0.0.1:${p.host}`;
          env.S3_BUCKET = config.projectName;
          env.AWS_ACCESS_KEY_ID = "creek";
          env.AWS_SECRET_ACCESS_KEY = "creek_sandbox";
          break;
        case "smtp":
          env.SMTP_URL = `smtp://127.0.0.1:${p.host}`;
          break;
      }
    }

    // SQLite fallback for database if no postgres/mysql port
    if (!env.DATABASE_URL) {
      const dbDir = join(this.options.cwd, ".creek", "dev");
      env.DATABASE_URL = `sqlite://${dbDir}/dev.db`;
    }

    return env;
  }

  private detectDevCommand(cwd: string, config: ResolvedConfig): string[] {
    // Check package.json for dev script
    const pkgPath = join(cwd, "package.json");
    if (existsSync(pkgPath)) {
      const { readFileSync } = require("node:fs");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.dev) {
        return ["npm", "run", "dev"];
      }
    }

    // Fallback to bun --watch or node --watch
    const entryFiles = ["src/index.ts", "src/index.mjs", "src/index.js", "index.ts", "index.mjs", "index.js"];
    for (const entry of entryFiles) {
      if (existsSync(join(cwd, entry))) {
        return ["bun", "--watch", entry];
      }
    }

    return ["bun", "--watch", "."];
  }

  /** For compatibility with DevServer interface */
  async triggerScheduled(): Promise<void> {
    consola.warn("Scheduled triggers not yet supported in creekd dev mode");
  }

  async sendQueueMessage(_payload: unknown): Promise<void> {
    consola.warn("Queue messages not yet supported in creekd dev mode");
  }
}
