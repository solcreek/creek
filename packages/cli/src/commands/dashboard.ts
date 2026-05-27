import { defineCommand } from "citty";
import consola from "consola";
import { execFileSync } from "node:child_process";
import { globalArgs, resolveJsonMode, jsonOutput } from "../utils/output.js";
import { CreekdClient, CreekdApiError, getCreekdUrl } from "../utils/creekd-client.js";

export const dashboardCommand = defineCommand({
  meta: {
    name: "dashboard",
    description: "Open the creekd web dashboard in your browser",
  },
  args: {
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
    const url = args.server || getCreekdUrl();
    const client = new CreekdClient(
      url,
      args.token || process.env.CREEKD_TOKEN || process.env.CREEKCTL_TOKEN || "",
    );

    try {
      await client.listApps();
    } catch (err) {
      if (err instanceof CreekdApiError && err.status === 401) {
        if (jsonMode) jsonOutput({ ok: false, error: "unauthorized", message: "Authentication required" }, 1);
        consola.error("Authentication failed. Set CREEKD_TOKEN or use --token.");
        process.exit(1);
      }
      if (jsonMode) jsonOutput({ ok: false, error: "unreachable", message: `Cannot reach creekd at ${url}` }, 1, [
        { command: "creek top --server <url>", description: "Check connection" },
      ]);
      consola.error(`Cannot reach creekd at ${url}`);
      consola.info("Is creekd running? Start it with: creekd");
      process.exit(1);
    }

    let dashboardUrl: string;
    try {
      const u = new URL(url);
      if (u.port === "9080") u.port = "3000";
      dashboardUrl = u.toString().replace(/\/$/, "");
    } catch {
      dashboardUrl = url;
    }

    if (jsonMode) {
      jsonOutput({ ok: true, url: dashboardUrl }, 0, [
        { command: "creek top", description: "CLI monitoring alternative" },
      ]);
    }

    consola.success(`Opening dashboard: ${dashboardUrl}`);
    openBrowser(dashboardUrl);
  },
});

function openBrowser(url: string) {
  try {
    const cmd = process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
    const args = process.platform === "win32"
      ? ["/c", "start", "", url]
      : [url];
    execFileSync(cmd, args, { stdio: "ignore" });
  } catch {
    consola.info(`Open manually: ${url}`);
  }
}
