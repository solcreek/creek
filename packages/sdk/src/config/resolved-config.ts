import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { Framework } from "../types/index.js";
import { BINDING_NAMES, type ResourceRequirements } from "../bindings/index.js";
import { detectFramework, getDefaultBuildOutput } from "../framework/index.js";
import { parseConfig } from "./index.js";
import { parseWranglerConfig, type WranglerConfig, type WranglerFormat } from "./wrangler.js";

// --- Types ---

export type BindingType = "d1" | "r2" | "kv" | "ai" | "durable_object" | "analytics_engine";

export interface BindingDeclaration {
  type: BindingType;
  name: string;
}

export type ConfigSource =
  | "creek.toml"
  | "wrangler.jsonc"
  | "wrangler.json"
  | "wrangler.toml"
  | "package.json"
  | "index.html";

export interface ResolvedConfig {
  source: ConfigSource;
  projectName: string;
  framework: Framework | null;
  buildCommand: string;
  buildOutput: string;
  workerEntry: string | null;
  bindings: BindingDeclaration[];
  unsupportedBindings: { type: string; name: string }[];
  vars: Record<string, string>;
  compatibilityDate: string | null;
  compatibilityFlags: string[];
}

/** Binding requirements sent to the control plane (new API path) */
export interface BindingRequirement {
  type: "d1" | "r2" | "kv" | "ai";
  bindingName: string;
}

// --- Detection chain ---

const WRANGLER_FILES: { file: string; format: WranglerFormat; source: ConfigSource }[] = [
  { file: "wrangler.jsonc", format: "jsonc", source: "wrangler.jsonc" },
  { file: "wrangler.json", format: "json", source: "wrangler.json" },
  { file: "wrangler.toml", format: "toml", source: "wrangler.toml" },
];

/**
 * Auto-detect project config from the working directory.
 *
 * Detection chain (first match wins):
 *   1. creek.toml
 *   2. wrangler.jsonc → wrangler.json → wrangler.toml
 *   3. package.json (framework detection)
 *   4. index.html (static site)
 *
 * Throws ConfigNotFoundError if nothing is detected.
 */
export function resolveConfig(cwd: string): ResolvedConfig {
  // 1. creek.toml
  const creekPath = join(cwd, "creek.toml");
  if (existsSync(creekPath)) {
    return fromCreekConfig(readFileSync(creekPath, "utf-8"), cwd);
  }

  // 2. wrangler.*
  for (const { file, format, source } of WRANGLER_FILES) {
    const path = join(cwd, file);
    if (existsSync(path)) {
      return fromWranglerConfig(readFileSync(path, "utf-8"), format, source, cwd);
    }
  }

  // 3. package.json
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const framework = detectFramework(pkg);
    if (framework) {
      return fromPackageJson(framework, cwd);
    }
  }

  // 4. index.html
  if (existsSync(join(cwd, "index.html")) || existsSync(join(cwd, "public/index.html"))) {
    return fromStaticSite(cwd);
  }

  throw new ConfigNotFoundError(cwd);
}

// --- Converters ---

function fromCreekConfig(toml: string, cwd: string): ResolvedConfig {
  const config = parseConfig(toml);
  const bindings: BindingDeclaration[] = [];

  // Semantic config names → CF-native binding types
  if (config.resources.database) bindings.push({ type: "d1", name: BINDING_NAMES.d1 });
  if (config.resources.storage)  bindings.push({ type: "r2", name: BINDING_NAMES.r2 });
  if (config.resources.cache)    bindings.push({ type: "kv", name: BINDING_NAMES.kv });
  if (config.resources.ai)       bindings.push({ type: "ai", name: BINDING_NAMES.ai });

  return {
    source: "creek.toml",
    projectName: config.project.name,
    framework: config.project.framework ?? null,
    buildCommand: config.build.command,
    buildOutput: config.build.output,
    workerEntry: config.build.worker ?? null,
    bindings,
    unsupportedBindings: [],
    vars: {},
    compatibilityDate: null,
    compatibilityFlags: [],
  };
}

function fromWranglerConfig(
  content: string,
  format: WranglerFormat,
  source: ConfigSource,
  cwd: string,
): ResolvedConfig {
  const wrangler = parseWranglerConfig(content, format);
  const bindings: BindingDeclaration[] = [];
  const unsupportedBindings: { type: string; name: string }[] = [];

  // D1 — take first if multiple
  if (wrangler.d1_databases?.length) {
    bindings.push({ type: "d1", name: wrangler.d1_databases[0].binding });
  }

  // KV — take first if multiple
  if (wrangler.kv_namespaces?.length) {
    bindings.push({ type: "kv", name: wrangler.kv_namespaces[0].binding });
  }

  // R2 — take first if multiple
  if (wrangler.r2_buckets?.length) {
    bindings.push({ type: "r2", name: wrangler.r2_buckets[0].binding });
  }

  // AI
  if (wrangler.ai) {
    const aiBindingName = typeof wrangler.ai === "object" && wrangler.ai.binding
      ? wrangler.ai.binding
      : BINDING_NAMES.ai;
    bindings.push({ type: "ai", name: aiBindingName });
  }

  // Analytics Engine
  if (wrangler.analytics_engine_datasets?.length) {
    for (const ae of wrangler.analytics_engine_datasets) {
      bindings.push({ type: "analytics_engine", name: ae.binding });
    }
  }

  // Durable Objects
  if (wrangler.durable_objects?.bindings?.length) {
    for (const d of wrangler.durable_objects.bindings) {
      bindings.push({ type: "durable_object", name: d.name });
    }
  }

  // Unsupported
  if (wrangler.queues) unsupportedBindings.push({ type: "queues", name: "queues" });
  if (wrangler.vectorize) unsupportedBindings.push({ type: "vectorize", name: "vectorize" });
  if (wrangler.hyperdrive) unsupportedBindings.push({ type: "hyperdrive", name: "hyperdrive" });

  // Try to detect framework from package.json even for wrangler projects
  let framework: Framework | null = null;
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      framework = detectFramework(JSON.parse(readFileSync(pkgPath, "utf-8")));
    } catch {
      // Ignore
    }
  }

  const dirName = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const isPureWorker = !!wrangler.main && !framework;

  return {
    source,
    projectName: wrangler.name ?? dirName,
    framework,
    // Pure Worker: no traditional build step — entry IS the app
    buildCommand: isPureWorker ? "" : "npm run build",
    buildOutput: framework ? getDefaultBuildOutput(framework) : (isPureWorker ? "." : "dist"),
    workerEntry: wrangler.main ?? null,
    bindings,
    unsupportedBindings,
    vars: wrangler.vars ?? {},
    compatibilityDate: wrangler.compatibility_date ?? null,
    compatibilityFlags: wrangler.compatibility_flags ?? [],
  };
}

function fromPackageJson(framework: Framework, cwd: string): ResolvedConfig {
  const dirName = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, "-");

  // Prefer package.json name as project slug (strip scope prefix)
  let projectName = dirName;
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
    if (pkg.name && typeof pkg.name === "string") {
      projectName = pkg.name.replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }
  } catch {}

  return {
    source: "package.json",
    projectName,
    framework,
    buildCommand: "npm run build",
    buildOutput: getDefaultBuildOutput(framework),
    workerEntry: null,
    bindings: [],
    unsupportedBindings: [],
    vars: {},
    compatibilityDate: null,
    compatibilityFlags: [],
  };
}

function fromStaticSite(cwd: string): ResolvedConfig {
  const dirName = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const hasPublicDir = existsSync(join(cwd, "public/index.html"));

  return {
    source: "index.html",
    projectName: dirName,
    framework: null,
    buildCommand: "",
    buildOutput: hasPublicDir ? "public" : ".",
    workerEntry: null,
    bindings: [],
    unsupportedBindings: [],
    vars: {},
    compatibilityDate: null,
    compatibilityFlags: [],
  };
}

// --- Utilities ---

/**
 * Human-readable one-liner for CLI output.
 * Example: "wrangler.jsonc (Hono + D1 + KV)" or "package.json (React Router)"
 */
export function formatDetectionSummary(config: ResolvedConfig): string {
  const parts: string[] = [];

  if (config.framework) {
    const frameworkNames: Record<string, string> = {
      nextjs: "Next.js",
      "tanstack-start": "TanStack Start",
      "react-router": "React Router",
      "vite-react": "Vite + React",
      "vite-vue": "Vite + Vue",
      "vite-svelte": "Vite + Svelte",
      "vite-solid": "Vite + Solid",
      sveltekit: "SvelteKit",
      solidstart: "SolidStart",
      nuxt: "Nuxt",
    };
    parts.push(frameworkNames[config.framework] ?? config.framework);
  }

  const resourceTypes = config.bindings
    .filter((b) => ["d1", "r2", "kv", "ai"].includes(b.type))
    .map((b) => b.type.toUpperCase());

  parts.push(...resourceTypes);

  if (config.source === "index.html") {
    parts.push("static site");
  }

  const detail = parts.length > 0 ? ` (${parts.join(" + ")})` : "";
  return `${config.source}${detail}`;
}

/**
 * Convert ResolvedConfig to legacy ResourceRequirements (boolean flags).
 * For backward compatibility with existing control plane API.
 */
export function resolvedConfigToResources(config: ResolvedConfig): ResourceRequirements {
  return {
    d1: config.bindings.some((b) => b.type === "d1"),
    r2: config.bindings.some((b) => b.type === "r2"),
    kv: config.bindings.some((b) => b.type === "kv"),
    ai: config.bindings.some((b) => b.type === "ai"),
  };
}

/**
 * Convert ResolvedConfig to BindingRequirements (with user-defined names).
 * For the new control plane API path.
 */
export function resolvedConfigToBindingRequirements(
  config: ResolvedConfig,
): BindingRequirement[] {
  return config.bindings
    .filter((b): b is BindingDeclaration & { type: "d1" | "r2" | "kv" | "ai" } =>
      ["d1", "r2", "kv", "ai"].includes(b.type),
    )
    .map((b) => ({ type: b.type, bindingName: b.name }));
}

// --- Errors ---

export class ConfigNotFoundError extends Error {
  constructor(cwd: string) {
    super(
      `No project config found in ${cwd}. Creek looks for: creek.toml, wrangler.jsonc/json/toml, package.json, or index.html.`,
    );
    this.name = "ConfigNotFoundError";
  }
}
