// DevServer orchestrator for `creek dev`.
//
// Manages the lifecycle of all subsystems:
//   1. LocalRealtimeServer — WebSocket broadcast
//   2. WorkerRunner — Miniflare with D1/KV/R2
//   3. ViteBridge — Client-side HMR
//   4. DevProxy — User-facing HTTP server

import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { consola } from "consola";
import type { ResolvedConfig } from "@solcreek/sdk";
import { LocalRealtimeServer } from "./local-realtime.js";
import { WorkerRunner } from "./worker-runner.js";
import { ViteBridge } from "./vite-bridge.js";
import { DevProxy } from "./dev-proxy.js";
import { findAvailablePort } from "./ports.js";

export interface DevServerOptions {
  cwd: string;
  port: number;
  config: ResolvedConfig;
  reset: boolean;
}

export class DevServer {
  private options: DevServerOptions;
  private realtimeServer: LocalRealtimeServer | null = null;
  private workerRunner: WorkerRunner | null = null;
  private viteBridge: ViteBridge | null = null;
  private proxy: DevProxy | null = null;

  constructor(options: DevServerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const { cwd, port, config, reset } = this.options;
    const persistDir = join(cwd, ".creek", "dev");
    const startTime = Date.now();

    // 1. Handle --reset
    if (reset && existsSync(persistDir)) {
      rmSync(persistDir, { recursive: true, force: true });
      consola.info("Cleared local data");
    }

    // Create persistence directory
    mkdirSync(persistDir, { recursive: true });

    // 2. Start realtime server
    this.realtimeServer = new LocalRealtimeServer({ port: 0 });
    await this.realtimeServer.start();

    // 3. Start worker (if project has a worker entry)
    let workerUrl: string | null = null;
    if (config.workerEntry) {
      this.workerRunner = new WorkerRunner({
        entryPoint: config.workerEntry,
        cwd,
        bindings: config.bindings,
        persistDir,
        realtimeUrl: `http://127.0.0.1:${this.realtimeServer.getPort()}`,
        projectSlug: config.projectName,
        vars: config.vars,
        cron: config.cron,
        queue: config.queue,
        onRebuild: (ms) => {
          consola.info(`Worker rebuilt in ${ms}ms`);
        },
      });
      const { port: workerPort } = await this.workerRunner.start();
      workerUrl = `http://127.0.0.1:${workerPort}`;
    }

    // 4. Start Vite (if project has a frontend framework)
    let viteMiddleware = null;
    const hasFramework = config.framework !== null;
    if (hasFramework) {
      this.viteBridge = new ViteBridge({ cwd });
      try {
        await this.viteBridge.start();
        viteMiddleware = this.viteBridge.middlewares;
      } catch (e: any) {
        if (e.message?.includes("Vite is not installed")) {
          consola.warn(e.message);
          this.viteBridge = null;
        } else {
          throw e;
        }
      }
    }

    // 5. Resolve port (auto-find if occupied)
    const actualPort = await findAvailablePort(port);
    if (actualPort !== port) {
      consola.warn(`Port ${port} is in use, using ${actualPort} instead`);
    }

    // 6. Start proxy
    this.proxy = new DevProxy({
      port: actualPort,
      workerUrl,
      viteMiddleware,
      realtimeServer: this.realtimeServer,
      projectSlug: config.projectName,
    });

    await this.proxy.start();

    // 7. Wire Vite's HMR to the proxy's HTTP server
    if (this.viteBridge && this.proxy.getServer()) {
      const httpServer = this.proxy.getServer()!;
      // Vite's middleware mode needs to handle upgrade events
      // from our proxy server for HMR WebSocket
      const viteWss = (this.viteBridge as any).viteServer?.ws;
      if (viteWss) {
        httpServer.on("upgrade", (req, socket, head) => {
          // Only handle Vite's HMR paths
          if (
            req.url?.startsWith("/__vite") ||
            req.url?.startsWith("/@vite")
          ) {
            viteWss.handleUpgrade(req, socket, head);
          }
        });
      }
    }

    // 8. Print status
    const elapsed = Date.now() - startTime;
    const bindings = config.bindings
      .filter((b) => ["d1", "kv", "r2", "ai"].includes(b.type))
      .map((b) => b.type.toUpperCase());
    const bindingStr = bindings.length > 0 ? ` (${bindings.join(", ")})` : "";

    console.log("");
    consola.success(`⬡ creek dev\n`);
    consola.info(`App:       http://localhost:${actualPort}`);
    if (config.workerEntry) {
      consola.info(`Worker:    ${config.workerEntry}${bindingStr}`);
    }
    consola.info(`Realtime:  ws://localhost:${actualPort}`);
    consola.info(`Data:      .creek/dev/`);
    if (config.cron.length > 0 || config.queue) {
      const triggers: string[] = [];
      if (config.cron.length > 0) triggers.push(`${config.cron.length} cron`);
      if (config.queue) triggers.push("queue");
      consola.info(`Triggers:  ${triggers.join(", ")}`);
    }
    console.log("");
    consola.success(`Ready in ${elapsed}ms`);

    if (config.cron.length > 0 || config.queue) {
      console.log("");
      consola.info("Trigger commands (type and press Enter):");
      if (config.cron.length > 0) {
        consola.info("  cron                      Trigger scheduled() handler");
      }
      if (config.queue) {
        consola.info('  queue <message>           Send a message to queue() handler');
      }
    }
  }

  /** Trigger the worker's scheduled() handler. */
  async triggerScheduled(): Promise<void> {
    if (!this.workerRunner) throw new Error("Worker not running");
    await this.workerRunner.triggerScheduled();
  }

  /** Send a message to the worker's queue() handler. */
  async sendQueueMessage(message: unknown): Promise<void> {
    if (!this.workerRunner) throw new Error("Worker not running");
    await this.workerRunner.sendQueueMessage(message);
  }

  async stop(): Promise<void> {
    // Stop in reverse order
    if (this.proxy) {
      await this.proxy.stop();
      this.proxy = null;
    }
    if (this.viteBridge) {
      await this.viteBridge.stop();
      this.viteBridge = null;
    }
    if (this.workerRunner) {
      await this.workerRunner.stop();
      this.workerRunner = null;
    }
    if (this.realtimeServer) {
      await this.realtimeServer.stop();
      this.realtimeServer = null;
    }
  }
}
