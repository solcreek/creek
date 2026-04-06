/**
 * Repo scanner — analyzes repos via GitHub Contents API (no clone needed).
 * Uses SDK for framework detection and config parsing.
 */

import { getRepoContents } from "./api.js";
import {
  detectFramework,
  parseWranglerConfig,
  type WranglerFormat,
} from "@solcreek/sdk";

export interface RepoScanResult {
  framework: string | null;
  configType: string | null;     // "wrangler.jsonc" | "wrangler.json" | "wrangler.toml" | "package.json"
  bindings: Array<{ type: string; name: string }>;
  envHints: string[];
  deployable: boolean;
}

/**
 * Scan a repo by reading config files via GitHub Contents API.
 * 6 parallel API calls ≈ 800ms.
 */
export async function scanRepo(
  token: string,
  owner: string,
  repo: string,
): Promise<RepoScanResult> {
  // Parallel fetch of all possible config files
  const [wranglerJsonc, wranglerJson, wranglerToml, packageJson, envExample] =
    await Promise.all([
      getRepoContents(token, owner, repo, "wrangler.jsonc"),
      getRepoContents(token, owner, repo, "wrangler.json"),
      getRepoContents(token, owner, repo, "wrangler.toml"),
      getRepoContents(token, owner, repo, "package.json"),
      getRepoContents(token, owner, repo, ".env.example"),
    ]);

  let framework: string | null = null;
  let configType: string | null = null;
  const bindings: Array<{ type: string; name: string }> = [];

  // Detect framework from package.json
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson);
      framework = detectFramework(pkg);
    } catch { /* invalid JSON */ }
  }

  // Parse wrangler config (first found wins)
  const wranglerConfigs: [string | null, WranglerFormat, string][] = [
    [wranglerJsonc, "jsonc", "wrangler.jsonc"],
    [wranglerJson, "json", "wrangler.json"],
    [wranglerToml, "toml", "wrangler.toml"],
  ];

  for (const [content, format, name] of wranglerConfigs) {
    if (!content) continue;
    configType = name;

    try {
      const config = parseWranglerConfig(content, format);

      if (config.d1_databases?.length) {
        for (const db of config.d1_databases) {
          bindings.push({ type: "d1", name: db.binding });
        }
      }
      if (config.kv_namespaces?.length) {
        for (const kv of config.kv_namespaces) {
          bindings.push({ type: "kv", name: kv.binding });
        }
      }
      if (config.r2_buckets?.length) {
        for (const r2 of config.r2_buckets) {
          bindings.push({ type: "r2", name: r2.binding });
        }
      }
      if (config.ai) {
        bindings.push({ type: "ai", name: "AI" });
      }
      if (config.analytics_engine_datasets?.length) {
        for (const ae of config.analytics_engine_datasets) {
          bindings.push({ type: "analytics_engine", name: ae.binding });
        }
      }
      if (config.durable_objects?.bindings?.length) {
        for (const d of config.durable_objects.bindings) {
          bindings.push({ type: "durable_object", name: d.name });
        }
      }
    } catch { /* parse error — skip */ }

    break; // Use first found config
  }

  // Extract env var hints from .env.example
  const envHints: string[] = [];
  if (envExample) {
    for (const line of envExample.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const key = trimmed.split("=")[0].trim();
      if (key && /^[A-Z_][A-Z0-9_]*$/.test(key)) {
        envHints.push(key);
      }
    }
  }

  // Determine if deployable
  const deployable = !!(configType || framework || packageJson);

  return { framework, configType, bindings, envHints, deployable };
}
