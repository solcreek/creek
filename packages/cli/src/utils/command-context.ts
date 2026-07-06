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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CreekClient, parseConfig } from "@solcreek/sdk";
import { getToken, getApiUrl } from "./config.js";
import { jsonOutput, AUTH_BREADCRUMBS, NO_PROJECT_BREADCRUMBS, type Breadcrumb } from "./output.js";

/**
 * An authenticated client, or a structured `not_authenticated` exit. In JSON
 * mode the error goes to stdout as `{ ok: false, error: "not_authenticated" }`
 * before exiting 1; otherwise the human hint prints.
 */
export function requireClient(jsonMode: boolean): CreekClient {
  const token = getToken();
  if (!token) {
    if (jsonMode) jsonOutput({ ok: false, error: "not_authenticated" }, 1, AUTH_BREADCRUMBS);
    consola.error("Not authenticated. Run `creek login` first.");
    process.exit(1);
  }
  return new CreekClient(getApiUrl(), token);
}

/**
 * Resolve the target project slug: an explicit `--project` arg wins, else the
 * `[project].name` from `./creek.toml`. On a miss, emits a structured
 * `no_project` error in JSON mode before exiting 1.
 */
export function resolveProjectSlug(argSlug: string | undefined, jsonMode: boolean): string {
  if (argSlug) return argSlug;
  const configPath = join(process.cwd(), "creek.toml");
  if (!existsSync(configPath)) {
    const message = "No creek.toml found. Use --project <slug> or run from a project directory.";
    if (jsonMode) jsonOutput({ ok: false, error: "no_project", message }, 1, NO_PROJECT_BREADCRUMBS);
    consola.error(message);
    process.exit(1);
  }
  try {
    return parseConfig(readFileSync(configPath, "utf-8")).project.name;
  } catch (err) {
    // An unreadable or malformed creek.toml would otherwise throw past the
    // structured-error contract and surface as a raw stack trace in JSON mode.
    const message = `Couldn't read creek.toml: ${err instanceof Error ? err.message : String(err)}`;
    if (jsonMode) jsonOutput({ ok: false, error: "invalid_config", message }, 1);
    consola.error(message);
    process.exit(1);
  }
}

/**
 * Run an API call, converting any rejection into a structured `{ ok: false,
 * error, message }` on stdout (JSON mode) or a human error line, then exit 1.
 * Returns the resolved value on success. Use this to wrap the network calls
 * that would otherwise reject into the top-level catch as unstructured text.
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
    if (jsonMode) jsonOutput({ ok: false, error: errorCode, message }, 1, breadcrumbs);
    consola.error(message);
    process.exit(1);
  }
}
