import { defineCommand } from "citty";
import consola from "consola";
import { execFileSync } from "node:child_process";
import { CreekClient } from "@solcreek/sdk";
import {
  writeCliConfig,
  readCliConfig,
  getApiUrl,
  getDashboardUrl,
  getTokenInfo,
} from "../utils/config.js";
import { startAuthServer } from "../utils/auth-server.js";
import { globalArgs, resolveJsonMode, jsonOutput, isTTY } from "../utils/output.js";
import { envOverrideWarning } from "../utils/api-key.js";

function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execFileSync(cmd, [url], { stdio: "ignore" });
  } catch {
    // Browser open failed — user will need to copy the URL manually
  }
}

export const loginCommand = defineCommand({
  meta: {
    name: "login",
    description: "Authenticate with Creek",
  },
  args: {
    token: {
      type: "string",
      description: "API key (for CI/CD, skips interactive prompt)",
      required: false,
    },
    headless: {
      type: "boolean",
      description: "Use headless mode (paste API key manually, for SSH/remote)",
      default: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);

    // Mode 1: --token (CI/CD / agents)
    if (args.token) {
      return await saveAndVerify(args.token, jsonMode);
    }

    // Browser and --headless both block on a human. Non-TTY (agents, CI)
    // would hang on the localhost callback or a prompt — fail immediately.
    if (!isTTY) {
      const message =
        "Non-interactive login requires --token <KEY>. Browser and --headless prompts hang in agents/CI.";
      if (jsonMode)
        jsonOutput({ ok: false, error: "interactive_login_unsupported", message }, 1, [
          {
            command: "creek login --token <KEY> --json",
            description: "Authenticate with an API key",
          },
        ]);
      consola.error(message);
      process.exit(1);
    }

    // Mode 2: --headless (SSH/remote — prompt for API key)
    if (args.headless) {
      return await headlessLogin();
    }

    // Mode 3: Default — localhost redirect (best UX)
    return await browserLogin();
  },
});

/**
 * Default login: open browser → dashboard creates API key → redirect to localhost callback.
 */
async function browserLogin() {
  const { port, state, waitForCallback, close } = await startAuthServer();
  const dashboardUrl = getDashboardUrl();
  const authUrl = `${dashboardUrl}/cli-auth?port=${port}&state=${state}`;

  consola.info("Opening browser to authenticate...");
  consola.info(`If the browser doesn't open, visit: ${authUrl}`);
  consola.info("");

  openBrowser(authUrl);
  consola.start("Waiting for authentication...");

  try {
    const key = await waitForCallback();
    await saveAndVerify(key);
  } catch (err) {
    close();
    consola.error(err instanceof Error ? err.message : "Authentication failed");
    consola.info("Try `creek login --headless` if browser login isn't working.");
    process.exit(1);
  }
}

/**
 * Headless login: prompt user to paste API key from dashboard.
 */
async function headlessLogin() {
  const dashboardUrl = getDashboardUrl();

  consola.info("Create an API key in the Creek dashboard:");
  consola.info(`  ${dashboardUrl}/api-keys`);
  consola.info("");

  const apiKey = await consola.prompt("Paste your API key:", { type: "text" });

  if (!apiKey || typeof apiKey !== "string") {
    consola.error("No API key provided");
    process.exit(1);
  }

  await saveAndVerify(apiKey.trim());
}

/**
 * Validate key against API, save to config, print success.
 */
async function saveAndVerify(apiKey: string, jsonMode = false) {
  if (!jsonMode) consola.start("Verifying...");
  // One URL for both: the key is bound to exactly the API that verified it,
  // even if the configured API changes while getSession() is pending.
  const apiUrl = getApiUrl();
  const client = new CreekClient(apiUrl, apiKey);
  const session = await client.getSession();

  if (!session?.user) {
    if (jsonMode)
      jsonOutput({ ok: false, error: "invalid_token", message: "Invalid API key" }, 1, [
        {
          command: "creek login --token <KEY> --json",
          description: "Retry with a valid API key",
        },
      ]);
    consola.error("Invalid API key. Please check and try again.");
    process.exit(1);
  }

  const config = readCliConfig();
  // Bind the key to the API it was verified against: getToken() refuses
  // to send it to any other (api_mismatch).
  writeCliConfig({ ...config, token: apiKey, tokenApiUrl: apiUrl });

  // CREEK_TOKEN wins over the key just saved; say so instead of letting
  // every later command silently use another key.
  const info = getTokenInfo();
  const warning = envOverrideWarning(info);

  if (jsonMode) {
    jsonOutput(
      {
        ok: true,
        user: session.user.name,
        email: session.user.email,
        saved: true,
        tokenSource: info.source,
        ...(warning ? { warning } : {}),
      },
      0,
      [
        ...(warning
          ? [{ command: "unset CREEK_TOKEN", description: "Use the key this login saved" }]
          : []),
        { command: "creek projects", description: "List your projects" },
        { command: "creek deploy --sandbox --json", description: "Deploy a 60-minute preview" },
        { command: "creek whoami --json", description: "Show the user and the API key in use" },
      ],
    );
  }

  consola.success(`Logged in as ${session.user.name} (${session.user.email})`);
  if (warning) {
    consola.warn(
      "CREEK_TOKEN is set in this environment and will keep winning: every command uses it, not the key saved now. Unset CREEK_TOKEN to use the saved key.",
    );
  }
}
