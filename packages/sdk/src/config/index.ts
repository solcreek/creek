import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const FRAMEWORKS = [
  "nextjs", "tanstack-start", "react-router",
  "vite-react", "vite-vue", "vite-svelte", "vite-solid",
  "sveltekit", "solidstart", "nuxt",
] as const;

export const CreekConfigSchema = z.object({
  project: z.object({
    name: z.string().regex(/^[a-z0-9-]+$/, "Project name must be lowercase alphanumeric with hyphens"),
    framework: z.enum(FRAMEWORKS).optional(),
  }),
  build: z.object({
    command: z.string().default("npm run build"),
    output: z.string().default("dist"),
    worker: z.string().optional(),
  }).default({}),
  resources: z.object({
    database: z.boolean().default(false),
    cache: z.boolean().default(false),
    storage: z.boolean().default(false),
    ai: z.boolean().default(false),
  }).default({}),
});

export type CreekConfig = z.infer<typeof CreekConfigSchema>;

export function parseConfig(tomlString: string): CreekConfig {
  const raw = parseToml(tomlString);
  return CreekConfigSchema.parse(raw);
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
