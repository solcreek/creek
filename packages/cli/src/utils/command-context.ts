/**
 * Shared command entry helpers so every command produces structured output in
 * JSON mode (auto-enabled for non-TTY: CI, pipes, agents). Previously each
 * command rolled its own `getClient` / `getProjectSlug` that printed only human
 * text before exiting, and many wrapped no try/catch around API calls — so a
 * failure reached the top-level catch and escaped as unstructured text. These
 * helpers centralize the `{ ok: false, error, message }` contract.
 *
 * `deployments.ts` is the reference for the shape these emit.
 */

import consola from "consola";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigNotFoundError,
  CreekClient,
  parseWranglerConfig,
  resolveConfig,
  type ResolvedConfig,
  type WranglerFormat,
} from "@solcreek/sdk";
import { getToken, getApiUrl } from "./config.js";
import { jsonOutput, AUTH_BREADCRUMBS, NO_PROJECT_BREADCRUMBS, type Breadcrumb } from "./output.js";
import { apiErrorFields, apiErrorHints } from "./api-error.js";

/**
 * An authenticated client, or a structured `not_authenticated` exit. In JSON
 * mode the error goes to stdout as `{ ok: false, error: "not_authenticated" }`
 * before exiting 1; otherwise the human hint prints.
 */
export function requireClient(jsonMode: boolean): CreekClient {
  const token = getToken();
  if (!token) {
    if (jsonMode)
      jsonOutput(
        {
          ok: false,
          error: "not_authenticated",
          message: "Not authenticated. Run `creek login` first.",
        },
        1,
        AUTH_BREADCRUMBS,
      );
    consola.error("Not authenticated. Run `creek login` first.");
    process.exit(1);
  }
  return new CreekClient(getApiUrl(), token);
}

/** The `--project` arg every command that resolves a project accepts. */
export const projectArg = {
  project: {
    type: "string" as const,
    description:
      "Project slug (default: the name this directory's config gives — creek.toml [project].name, else the wrangler config name, else the framework package.json name; never the directory name)",
    valueHint: "slug",
  },
};

/**
 * What a project command prints when it can't tell which project to act on.
 * Every command that resolves through {@link resolveProject} accepts
 * `--project` (a test checks the command arg schemas), so the hint never
 * names a flag the command lacks.
 */
export const NO_PROJECT_MESSAGE =
  "No project found in this directory (no creek.toml, wrangler config or framework package.json). Pass --project <slug> or run from a project directory.";

/** Breadcrumbs for a project command's `no_project` error. */
export const PROJECT_COMMAND_NO_PROJECT_BREADCRUMBS: Breadcrumb[] = [
  {
    command: "creek projects --json",
    description: "List your projects, then pass one with --project <slug>",
  },
  ...NO_PROJECT_BREADCRUMBS,
];

/** Where a project command's slug came from. */
export type ProjectSource = "flag" | "creek.toml" | "wrangler" | "package.json";

/**
 * What a directory says about its project. `slug` is null when a config was
 * found but names no project: `resolveConfig` then falls back to the directory
 * name (a static site, a wrangler config without `name`, a package.json
 * without `name`), which project commands refuse to act on.
 */
export type DirectoryProject =
  | { slug: string; source: Exclude<ProjectSource, "flag">; config: ResolvedConfig }
  | { slug: null; file: string; config: ResolvedConfig };

/**
 * The project a directory deploys as, resolved by the SDK's `resolveConfig`
 * like `creek deploy`, keeping only names someone wrote down: `creek.toml`
 * `[project].name`, else the wrangler config's `name`, else the framework
 * package.json `name`. Returns null when the directory holds no project
 * config; rethrows when a config exists but can't be read.
 */
export function projectFromDirectory(cwd: string = process.cwd()): DirectoryProject | null {
  let config: ResolvedConfig;
  try {
    config = resolveConfig(cwd);
  } catch (err) {
    if (err instanceof ConfigNotFoundError) return null;
    throw err;
  }
  const unnamed = { slug: null, file: config.source, config } as const;
  switch (config.source) {
    case "creek.toml":
      // The schema requires [project].name.
      return { slug: config.projectName, source: "creek.toml", config };
    case "wrangler.jsonc":
    case "wrangler.json":
    case "wrangler.toml": {
      const format = config.source === "wrangler.toml" ? "toml" : config.source.slice(9);
      const wrangler = parseWranglerConfig(
        readFileSync(join(cwd, config.source), "utf-8"),
        format as WranglerFormat,
      );
      return wrangler.name ? { slug: config.projectName, source: "wrangler", config } : unnamed;
    }
    case "package.json": {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8")) as {
        name?: unknown;
      };
      return typeof pkg.name === "string" && pkg.name
        ? { slug: config.projectName, source: "package.json", config }
        : unnamed;
    }
    default:
      // index.html: a static site's only name is the directory's.
      return unnamed;
  }
}

/** Why a directory with a config still names no project. */
export function unnamedProjectMessage(file: string): string {
  const what =
    file === "index.html"
      ? "Found a static site (index.html) but no project name"
      : `Found ${file} but it has no "name"`;
  return `${what}, and project commands never use the directory name as the project. Pass --project <slug>, or name the project in creek.toml ([project].name), the wrangler config ("name") or package.json ("name").`;
}

/**
 * Resolve the target project: an explicit `--project` arg wins, else the
 * project the current directory names ({@link projectFromDirectory}). On a
 * miss, or a config that names no project, emits a structured `no_project`
 * error in JSON mode before exiting 1; a config that can't be read emits
 * `invalid_config`.
 */
export function resolveProject(
  argSlug: string | undefined,
  jsonMode: boolean,
): { slug: string; source: ProjectSource } {
  if (argSlug) return { slug: argSlug, source: "flag" };
  let found: DirectoryProject | null;
  try {
    found = projectFromDirectory();
  } catch (err) {
    // An unreadable or malformed config would otherwise throw past the
    // structured-error contract and surface as a raw stack trace in JSON mode.
    const message = `Couldn't read the project config: ${err instanceof Error ? err.message : String(err)}`;
    if (jsonMode) jsonOutput({ ok: false, error: "invalid_config", message }, 1);
    consola.error(message);
    process.exit(1);
  }
  if (!found || found.slug === null) {
    const message = found ? unnamedProjectMessage(found.file) : NO_PROJECT_MESSAGE;
    if (jsonMode)
      jsonOutput(
        { ok: false, error: "no_project", message, ...(found ? { foundConfig: found.file } : {}) },
        1,
        PROJECT_COMMAND_NO_PROJECT_BREADCRUMBS,
      );
    consola.error(message);
    process.exit(1);
  }
  return { slug: found.slug, source: found.source };
}

/** {@link resolveProject}, for callers that need only the slug. */
export function resolveProjectSlug(argSlug: string | undefined, jsonMode: boolean): string {
  return resolveProject(argSlug, jsonMode).slug;
}

/**
 * Run an API call, converting any rejection into a structured `{ ok: false,
 * error, message }` on stdout (JSON mode) or a human error line, then exit 1.
 * `error` stays the command's own code; a failed API call adds its `status`,
 * `apiError` and `details` (apiErrorFields). Returns the resolved value on
 * success. Use this to wrap the network calls that would otherwise reject
 * into the top-level catch as unstructured text.
 */
export async function apiCall<T>(
  jsonMode: boolean,
  errorCode: string,
  fn: () => Promise<T>,
  breadcrumbs?: Breadcrumb[],
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      jsonOutput({ ok: false, error: errorCode, message, ...apiErrorFields(err) }, 1, breadcrumbs);
    }
    consola.error(message);
    for (const hint of apiErrorHints(err)) consola.info(hint);
    process.exit(1);
  }
}
