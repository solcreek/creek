import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface CliConfig {
  token?: string;
  /**
   * The API `creek login` verified the saved token against: the token is
   * bound to it and never sent to another API. Absent in configs written
   * by older CLIs: such a token is unbound (its API is unknown) and is
   * sent to the API in use, as before.
   */
  tokenApiUrl?: string;
  apiUrl?: string;
}

export const DEFAULT_API_URL = "https://api.creek.dev";

/**
 * An API URL as compared for key binding: its origin (scheme, lower-cased
 * host, port with the scheme's default dropped) plus its path without
 * trailing slashes. A string that is not a URL is compared as written.
 */
function normalizeApiUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return url.replace(/\/+$/, "");
  }
}

/** Whether two API URLs name the same API. */
export function sameApiUrl(a: string, b: string): boolean {
  return normalizeApiUrl(a) === normalizeApiUrl(b);
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
 * Remove the stored API key (and the API it was saved for), keeping the
 * rest of the config (apiUrl). With `expected`, only when the config still
 * holds exactly that key: a `creek login` that ran meanwhile is kept.
 * Returns whether a key was removed.
 */
export function clearCliToken(expected?: string): boolean {
  const config = readCliConfig();
  if (config.token === undefined) return false;
  if (expected !== undefined && config.token !== expected) return false;
  const { token: _token, tokenApiUrl: _url, ...rest } = config;
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
  /** The key saved by `creek login`, if any (whether or not it is in use). */
  savedToken: string | undefined;
  /** The API the saved key is bound to; undefined when unbound or none. */
  savedApiUrl: string | undefined;
  /**
   * A saved key from an older CLI, with no recorded API: it is sent to the
   * API in use, as before. `creek login` again binds it.
   */
  savedKeyUnbound: boolean;
  /**
   * The saved key is bound to another API than the one the CLI would talk
   * to now: it must not be sent (or revoked, or cleared) here.
   */
  savedKeyApiMismatch: boolean;
}

/**
 * The key in use and where it came from. Same precedence as getToken():
 * CREEK_TOKEN, when set at all (even empty), wins over the stored key.
 */
export function getTokenInfo(): TokenInfo {
  const config = readCliConfig();
  const stored = config.token || undefined;
  const savedApiUrl = stored ? config.tokenApiUrl : undefined;
  const saved = {
    savedToken: stored,
    savedApiUrl,
    savedKeyUnbound: Boolean(stored) && !config.tokenApiUrl,
    savedKeyApiMismatch: savedApiUrl !== undefined && !sameApiUrl(savedApiUrl, getApiUrl()),
  };
  const env = process.env.CREEK_TOKEN;
  if (env !== undefined) {
    return {
      token: env,
      source: "env:CREEK_TOKEN",
      shadowsConfigToken: Boolean(stored) && stored !== env,
      ...saved,
    };
  }
  return { token: stored, source: stored ? "config" : null, shadowsConfigToken: false, ...saved };
}

export function getToken(): string | undefined {
  return process.env.CREEK_TOKEN ?? readCliConfig().token;
}

export function getApiUrl(): string {
  return process.env.CREEK_API_URL ?? readCliConfig().apiUrl ?? DEFAULT_API_URL;
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
