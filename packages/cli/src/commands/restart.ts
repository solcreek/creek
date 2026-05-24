import { defineCommand } from "citty";
import consola from "consola";
import { globalArgs, resolveJsonMode, jsonOutput } from "../utils/output.js";
import { CreekdClient, CreekdApiError, getCreekdUrl } from "../utils/creekd-client.js";

export const restartCommand = defineCommand({
  meta: {
    name: "restart",
    description: "Restart an app on a creekd instance",
  },
  args: {
    id: {
      type: "positional",
      description: "App ID to restart",
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

    try {
      const app = await client.restartApp(args.id as string);
      if (jsonMode) {
        jsonOutput({ ok: true, app }, 0, [
          { command: `creek logs ${app.id}`, description: "Stream app logs" },
          { command: `creek top`, description: "Live process overview" },
        ]);
      }
      consola.success(`Restarted ${app.id} (pid ${app.pid})`);
    } catch (err) {
      if (err instanceof CreekdApiError) {
        if (jsonMode) jsonOutput({ ok: false, error: err.code, message: err.message }, 1);
        if (err.status === 404) {
          consola.error(`App "${args.id}" not found.`);
        } else {
          consola.error(`Restart failed: ${err.message}`);
        }
        process.exit(1);
      }
      throw err;
    }
  },
});
