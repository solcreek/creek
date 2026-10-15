import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface CliConfig {
  token?: string;
  apiUrl?: string;
}

// Resolved on each call (not at import), so HOME decides where the config
// lives for the whole run, tests included.
function configDir(): string {
  return join(homedir(), ".creek");
}

function configFile(): string {
  return join(configDir(), "config.json");
}

export function getConfigDir(): string {
  return configDir();
}

export function readCliConfig(): CliConfig {
  const file = configFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

export function writeCliConfig(config: CliConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Remove the stored API key, keeping the rest of the config (apiUrl).
 * Returns whether there was one.
 */
export function clearCliToken(): boolean {
  const config = readCliConfig();
  if (config.token === undefined) return false;
  const { token: _token, ...rest } = config;
  writeCliConfig(rest);
  return true;
}

/** Where the API key in use comes from. */
export type TokenSource = "env:CREEK_TOKEN" | "config";

export interface TokenInfo {
  /** The key every command sends; "" or undefined means not authenticated. */
  token: string | undefined;
  source: TokenSource | null;
  /**
   * CREEK_TOKEN is set (even empty) and a different key is stored by
   * `creek login`: the stored key is ignored while the variable is set.
   */
  shadowsConfigToken: boolean;
}

/**
 * The key in use and where it came from. Same precedence as getToken():
 * CREEK_TOKEN, when set at all (even empty), wins over the stored key.
 */
export function getTokenInfo(): TokenInfo {
  const env = process.env.CREEK_TOKEN;
  if (env !== undefined) {
    const stored = readCliConfig().token;
    return {
      token: env,
      source: "env:CREEK_TOKEN",
      shadowsConfigToken: Boolean(stored) && stored !== env,
    };
  }
  const stored = readCliConfig().token;
  return { token: stored, source: stored ? "config" : null, shadowsConfigToken: false };
}

export function getToken(): string | undefined {
  return getTokenInfo().token;
}

export function getApiUrl(): string {
  return process.env.CREEK_API_URL ?? readCliConfig().apiUrl ?? "https://api.creek.dev";
}

/**
 * The dashboard for the API in use:
 *   https://api.creek.dev → https://app.creek.dev
 *   http://localhost:8787 → http://localhost:3000
 */
export function getDashboardUrl(): string {
  return getApiUrl().replace("api.", "app.").replace(":8787", ":3000");
}

export function getSandboxApiUrl(): string {
  return process.env.CREEK_SANDBOX_API_URL ?? "https://sandbox-api.creek.dev";
}
