import { defineCommand } from "citty";
import consola from "consola";
import { execFileSync } from "node:child_process";
import { CreekClient } from "@solcreek/sdk";
import { writeCliConfig, readCliConfig, getApiUrl } from "../utils/config.js";
import { startAuthServer } from "../utils/auth-server.js";
import { globalArgs, resolveJsonMode, jsonOutput, type Breadcrumb } from "../utils/output.js";

function getDashboardUrl(): string {
  const apiUrl = getApiUrl();
  // http://localhost:8787 → http://localhost:3000
  // https://api.creek.dev → https://app.creek.dev
  return apiUrl
    .replace("api.", "app.")
    .replace(":8787", ":3000");
}

function openBrowser(url: string): void {
  try {
    const cmd = process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
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

    // Mode 1: --token (CI/CD)
    if (args.token) {
      return await saveAndVerify(args.token, jsonMode);
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
  const { port, state, waitForCallback, close } = startAuthServer();
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
  const client = new CreekClient(getApiUrl(), apiKey);
  const session = await client.getSession();

  if (!session?.user) {
    if (jsonMode) jsonOutput({ ok: false, error: "invalid_token", message: "Invalid API key" }, 1, [
      { command: "creek login", description: "Try interactive login" },
      { command: "creek login --headless", description: "Paste API key manually" },
    ]);
    consola.error("Invalid API key. Please check and try again.");
    process.exit(1);
  }

  const config = readCliConfig();
  writeCliConfig({ ...config, token: apiKey });

  if (jsonMode) {
    jsonOutput({ ok: true, user: session.user.name, email: session.user.email }, 0, [
      { command: "creek projects", description: "List your projects" },
      { command: "creek deploy", description: "Deploy current directory" },
      { command: "creek whoami", description: "Verify authenticated user" },
    ]);
  }

  consola.success(`Logged in as ${session.user.name} (${session.user.email})`);
}
