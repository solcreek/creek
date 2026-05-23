import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const FRAMEWORKS = [
  "nextjs", "tanstack-start", "react-router",
  "vite-react", "vite-vue", "vite-svelte", "vite-solid",
  "sveltekit", "solidstart", "nuxt",
] as const;

export const DEPLOY_TARGETS = ["cf", "creekd"] as const;
export type DeployTarget = (typeof DEPLOY_TARGETS)[number];

const DATABASE_DRIVERS = ["sqlite", "postgres", "mysql"] as const;
const CACHE_DRIVERS = ["sqlite", "redis"] as const;
const STORAGE_DRIVERS = ["fs", "s3"] as const;

export const CreekConfigSchema = z.object({
  project: z.object({
    name: z.string().regex(/^[a-z0-9-]+$/, "Project name must be lowercase alphanumeric with hyphens"),
    target: z.enum(DEPLOY_TARGETS).optional(),
    framework: z.enum(FRAMEWORKS).optional(),
  }),
  build: z.object({
    command: z.string().default("npm run build"),
    output: z.string().default("dist"),
    worker: z.string().optional(),
  }).default({}),
  // v1 format: boolean resource flags (CF Workers bindings)
  resources: z.object({
    database: z.boolean().default(false),
    cache: z.boolean().default(false),
    storage: z.boolean().default(false),
    ai: z.boolean().default(false),
  }).default({}),
  // v2 format: semantic driver declarations (multi-target)
  database: z.object({
    driver: z.enum(DATABASE_DRIVERS).default("sqlite"),
  }).optional(),
  cache: z.object({
    driver: z.enum(CACHE_DRIVERS).default("sqlite"),
  }).optional(),
  storage: z.object({
    driver: z.enum(STORAGE_DRIVERS).default("fs"),
  }).optional(),
  email: z.object({
    enabled: z.boolean().default(false),
  }).optional(),
  release: z.object({
    command: z.string(),
    timeout: z.number().default(60),
  }).optional(),
  triggers: z.object({
    cron: z.array(z.string()).default([]),
    queue: z.boolean().default(false),
  }).default({}),
});

export type CreekConfig = z.infer<typeof CreekConfigSchema>;

export function parseConfig(tomlString: string): CreekConfig {
  const raw = parseToml(tomlString);
  return CreekConfigSchema.parse(raw);
}

/**
 * Detect the deploy target from creek.toml config.
 *
 * 1. Explicit `target` → use it
 * 2. v2 driver sections → infer (postgres/redis → creekd, sqlite → cf)
 * 3. v1 boolean resources only → cf
 */
export function detectTarget(config: CreekConfig): DeployTarget {
  if (config.project.target) {
    return config.project.target;
  }

  const hasV2 = config.database || config.cache || config.storage;
  if (!hasV2) {
    return "cf";
  }

  const dbDriver = config.database?.driver ?? "sqlite";
  const cacheDriver = config.cache?.driver ?? "sqlite";

  if (dbDriver === "postgres" || dbDriver === "mysql" || cacheDriver === "redis") {
    return "creekd";
  }

  return "cf";
}

/**
 * Validate driver choices are compatible with the target.
 * Throws on incompatible combinations at parse time.
 */
export function validateTargetDrivers(config: CreekConfig): void {
  const target = detectTarget(config);
  const dbDriver = config.database?.driver;
  const cacheDriver = config.cache?.driver;

  if (target === "cf") {
    if (dbDriver === "postgres" || dbDriver === "mysql") {
      throw new Error(
        `Incompatible: target "cf" does not support database driver "${dbDriver}". ` +
        `Use driver = "sqlite" (maps to D1) or set target = "creekd".`
      );
    }
    if (cacheDriver === "redis") {
      throw new Error(
        `Incompatible: target "cf" does not support cache driver "redis". ` +
        `Use driver = "sqlite" (maps to KV) or set target = "creekd".`
      );
    }
  }
}

export const CONFIG_FILENAME = "creek.toml";

// Re-export new modules
export { stripJsoncComments } from "./jsonc.js";
export { parseWranglerConfig, type WranglerConfig, type WranglerFormat } from "./wrangler.js";
export {
  resolveConfig,
  formatDetectionSummary,
  resolvedConfigToResources,
  resolvedConfigToBindingRequirements,
  ConfigNotFoundError,
  type ResolvedConfig,
  type BindingDeclaration,
  type BindingRequirement,
  type BindingType,
  type ConfigSource,
} from "./resolved-config.js";
