import { downloadTemplate } from "giget";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/**
 * Default source for built-in templates. Points at the monorepo's
 * `examples/` directory so the templates ARE the examples we actually
 * dogfood and test — no separate `solcreek/templates` repo to drift
 * out of sync. Third-party templates (`github:user/repo`) pass
 * through unchanged; see isThirdParty() below.
 */
const TEMPLATE_REPO = "github:solcreek/creek/examples";

export interface FetchResult {
  dir: string;
  templateConfig: TemplateConfig | null;
  defaultData: Record<string, unknown>;
}

export interface TemplateConfig {
  name: string;
  description: string;
  capabilities: string[];
  thumbnail?: string;
  screenshot?: string;
  schema?: Record<string, unknown>;
}

/**
 * Download a template into `dest`.
 *
 * Built-in templates:  "landing"  → github:solcreek/templates/landing
 * Third-party:         "github:user/repo" → passed to giget directly
 */
export async function fetchTemplate(
  template: string,
  dest: string,
): Promise<FetchResult> {
  const source = isThirdParty(template)
    ? template
    : `${TEMPLATE_REPO}/${template}`;

  const { dir } = await downloadTemplate(source, {
    dir: dest,
    force: true,
  });

  // Read creek-template.json if present
  const configPath = join(dir, "creek-template.json");
  let templateConfig: TemplateConfig | null = null;
  if (existsSync(configPath)) {
    templateConfig = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  // Read creek-data.json defaults if present
  const dataPath = join(dir, "creek-data.json");
  let defaultData: Record<string, unknown> = {};
  if (existsSync(dataPath)) {
    defaultData = JSON.parse(readFileSync(dataPath, "utf-8"));
  }

  return { dir, templateConfig, defaultData };
}

function isThirdParty(template: string): boolean {
  return (
    template.includes(":") || template.includes("/") || template.startsWith(".")
  );
}
