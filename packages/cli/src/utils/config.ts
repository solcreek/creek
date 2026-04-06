import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".creek");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface CliConfig {
  token?: string;
  apiUrl?: string;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function readCliConfig(): CliConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function writeCliConfig(config: CliConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getToken(): string | undefined {
  return process.env.CREEK_TOKEN ?? readCliConfig().token;
}

export function getApiUrl(): string {
  return (
    process.env.CREEK_API_URL ??
    readCliConfig().apiUrl ??
    "https://api.creek.dev"
  );
}

export function getSandboxApiUrl(): string {
  return (
    process.env.CREEK_SANDBOX_API_URL ??
    "https://sandbox-api.creek.dev"
  );
}
