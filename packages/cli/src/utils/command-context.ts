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
import {
  ConfigNotFoundError,
  CreekClient,
  resolveConfig,
  type ResolvedConfig,
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
      "Project slug (default: the project this directory deploys as — creek.toml, else the wrangler config name)",
    valueHint: "slug",
  },
};

/**
 * What a project command prints when it can't tell which project to act on.
 * Every command that resolves through {@link resolveProjectSlug} accepts
 * `--project` (a test checks the command arg schemas), so the hint never
 * names a flag the command lacks.
 */
export const NO_PROJECT_MESSAGE =
  "No project found in this directory (no creek.toml, wrangler config, framework package.json or index.html). Pass --project <slug> or run from a project directory.";

/** Breadcrumbs for a project command's `no_project` error. */
export const PROJECT_COMMAND_NO_PROJECT_BREADCRUMBS: Breadcrumb[] = [
  {
    command: "creek projects --json",
    description: "List your projects, then pass one with --project <slug>",
  },
  ...NO_PROJECT_BREADCRUMBS,
];

/**
 * The project a directory deploys as, resolved the way `creek deploy` does
 * (SDK `resolveConfig`): `creek.toml` `[project].name`, else the wrangler
 * config's `name`, else the framework package.json `name`, else the directory
 * name of a static site. Returns null when the directory holds no project
 * config; rethrows when a config exists but can't be read.
 */
export function projectFromDirectory(
  cwd: string = process.cwd(),
): { slug: string; config: ResolvedConfig } | null {
  try {
    const config = resolveConfig(cwd);
    return { slug: config.projectName, config };
  } catch (err) {
    if (err instanceof ConfigNotFoundError) return null;
    throw err;
  }
}

/**
 * Resolve the target project slug: an explicit `--project` arg wins, else the
 * project the current directory deploys as ({@link projectFromDirectory}). On
 * a miss, emits a structured `no_project` error in JSON mode before exiting 1;
 * a config that can't be read emits `invalid_config`.
 */
export function resolveProjectSlug(argSlug: string | undefined, jsonMode: boolean): string {
  if (argSlug) return argSlug;
  let found: ReturnType<typeof projectFromDirectory>;
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
  if (!found) {
    if (jsonMode)
      jsonOutput(
        { ok: false, error: "no_project", message: NO_PROJECT_MESSAGE },
        1,
        PROJECT_COMMAND_NO_PROJECT_BREADCRUMBS,
      );
    consola.error(NO_PROJECT_MESSAGE);
    process.exit(1);
  }
  return found.slug;
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
