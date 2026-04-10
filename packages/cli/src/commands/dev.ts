import { defineCommand } from "citty";
import { consola } from "consola";
import { resolveConfig, formatDetectionSummary } from "@solcreek/sdk";
import { globalArgs } from "../utils/output.js";
import { DevServer } from "../dev/server.js";

export const devCommand = defineCommand({
  meta: {
    name: "dev",
    description: "Start local development server",
  },
  args: {
    ...globalArgs,
    port: {
      type: "string",
      description: "Port number (default: 3000)",
      default: "3000",
    },
    reset: {
      type: "boolean",
      description: "Clear local data before starting",
    },
  },
  async run({ args }) {
    const cwd = process.cwd();

    let config;
    try {
      config = resolveConfig(cwd);
    } catch (e: any) {
      consola.error(e.message);
      process.exit(1);
    }

    const port = parseInt(args.port as string, 10);
    if (isNaN(port) || port < 0 || port > 65535) {
      consola.error(`Invalid port: ${args.port}`);
      process.exit(1);
    }

    consola.info(`Detected: ${formatDetectionSummary(config)}`);

    const server = new DevServer({
      cwd,
      port,
      config,
      reset: !!args.reset,
    });

    // Graceful shutdown
    const shutdown = async () => {
      consola.info("Shutting down...");
      await server.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    try {
      await server.start();
    } catch (e: any) {
      consola.error(`Failed to start dev server: ${e.message}`);
      await server.stop();
      process.exit(1);
    }

    // Interactive trigger commands (only if cron/queue configured)
    if (config.cron.length > 0 || config.queue) {
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.on("line", async (line) => {
        const input = line.trim();
        if (!input) return;

        if (input === "cron" && config.cron.length > 0) {
          try {
            await server.triggerScheduled();
            consola.success("Triggered scheduled()");
          } catch (e: any) {
            consola.error(`scheduled() error: ${e.message}`);
          }
          return;
        }

        if (input.startsWith("queue ") && config.queue) {
          const payload = input.slice(6).trim();
          let parsed: unknown = payload;
          try {
            parsed = JSON.parse(payload);
          } catch {
            // Not JSON, send as string
          }
          try {
            await server.sendQueueMessage(parsed);
            consola.success(`Sent message to queue()`);
          } catch (e: any) {
            consola.error(`queue() error: ${e.message}`);
          }
          return;
        }

        consola.warn(`Unknown command: ${input}`);
      });
    }
  },
});
