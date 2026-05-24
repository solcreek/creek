import { defineCommand } from "citty";
import consola from "consola";
import { globalArgs, resolveJsonMode, jsonOutput, shouldAutoConfirm } from "../utils/output.js";
import { CreekdClient, CreekdApiError, getCreekdUrl } from "../utils/creekd-client.js";

export const stopCommand = defineCommand({
  meta: {
    name: "stop",
    description: "Stop an app on a creekd instance",
  },
  args: {
    id: {
      type: "positional",
      description: "App ID to stop",
      required: true,
    },
    server: {
      type: "string",
      description: "creekd admin API URL (or $CREEKD_URL)",
    },
    token: {
      type: "string",
      description: "Bearer token (or $CREEKD_TOKEN)",
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = new CreekdClient(
      args.server || getCreekdUrl(),
      args.token || process.env.CREEKD_TOKEN || process.env.CREEKCTL_TOKEN || "",
    );
    const id = args.id as string;

    if (!shouldAutoConfirm(args) && !jsonMode) {
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Stop app "${id}"? [y/N] `);
      rl.close();
      if (answer.toLowerCase() !== "y") {
        consola.info("Aborted.");
        return;
      }
    }

    try {
      await client.stopApp(id);
      if (jsonMode) {
        jsonOutput({ ok: true, stopped: id }, 0, [
          { command: `creek top`, description: "Live process overview" },
        ]);
      }
      consola.success(`Stopped ${id}`);
    } catch (err) {
      if (err instanceof CreekdApiError) {
        if (jsonMode) jsonOutput({ ok: false, error: err.code, message: err.message }, 1);
        if (err.status === 404) {
          consola.error(`App "${id}" not found.`);
        } else {
          consola.error(`Stop failed: ${err.message}`);
        }
        process.exit(1);
      }
      throw err;
    }
  },
});
