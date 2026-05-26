import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient, parseConfig } from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalArgs, resolveJsonMode, jsonOutput, AUTH_BREADCRUMBS } from "../utils/output.js";
import { CreekdClient, CreekdResourceVersionMismatchError, type Release } from "../utils/creekd-client.js";
import { readHosts, findHost } from "../utils/hosts.js";
import {
  cachedResourceVersion,
  recordLastDeploy,
} from "../utils/local-cache.js";

function getProjectSlug(args?: { project?: string }): string {
  if (args?.project) return args.project;
  const configPath = join(process.cwd(), "creek.toml");
  if (!existsSync(configPath)) {
    consola.error("No creek.toml found. Use --project <slug> or run from a project directory.");
    process.exit(1);
  }
  return parseConfig(readFileSync(configPath, "utf-8")).project.name;
}

export const rollbackCommand = defineCommand({
  meta: {
    name: "rollback",
    description: "Rollback production to a previous deployment",
  },
  args: {
    deployment: {
      type: "positional",
      description: "Deployment ID to rollback to (default: previous, CF Workers target)",
      required: false,
    },
    message: {
      type: "string",
      alias: "m",
      description: "Rollback reason (stored in audit log)",
    },
    project: {
      type: "string",
      description: "Project slug (default: from creek.toml)",
    },
    host: {
      type: "string",
      description: "Roll back on the named self-host creekd (from ~/.creek/hosts.json). Requires --to.",
    },
    to: {
      type: "string",
      description: "Target release seq for self-host rollback (--host required).",
    },
    "bypass-rv": {
      type: "boolean",
      description: "On 412 If-Match mismatch, auto-fetch current rv and retry (self-host only).",
      default: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);

    // Self-host path — bypass the CF Workers / CreekClient flow.
    // Mutually exclusive with the existing CF rollback semantics:
    // --host pivots into the creekd HTTP API per
    // DESIGN-self-host-state.md §"The Release resource".
    if (args.host) {
      return await rollbackSelfHost(
        args.host as string,
        args.to as string | undefined,
        args.project as string | undefined,
        args["bypass-rv"] === true,
        jsonMode,
      );
    }
    if (args.to) {
      const msg = "--to requires --host (use --deployment for CF Workers rollback)";
      if (jsonMode) jsonOutput({ ok: false, error: "missing_host", message: msg }, 1, []);
      consola.error(msg);
      process.exit(1);
    }

    const token = getToken();

    if (!token) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_authenticated", message: "Not authenticated" }, 1, AUTH_BREADCRUMBS);
      consola.error("Not authenticated. Run `creek login` first.");
      process.exit(1);
    }

    const projectSlug = getProjectSlug(args as { project?: string });
    const client = new CreekClient(getApiUrl(), token);

    const deploymentId = args.deployment as string | undefined;
    const message = args.message as string | undefined;

    try {
      const result = await client.rollback(projectSlug, {
        deploymentId: deploymentId || undefined,
        message: message || undefined,
      });

      if (jsonMode) {
        jsonOutput(result, 0, [
          { command: `creek status`, description: "Verify rollback status" },
          { command: `creek deployments --project ${projectSlug}`, description: "View deployment history" },
        ]);
        return;
      }

      consola.success(`⬡ Rolled back to deployment ${result.rolledBackTo.slice(0, 8)}`);
      consola.info(`Production URL: ${result.url}`);
      if (message) {
        consola.info(`Reason: ${message}`);
      }
    } catch (err: any) {
      const msg = err.message ?? "Rollback failed";
      if (jsonMode) jsonOutput({ ok: false, error: "rollback_failed", message: msg }, 1, [
        { command: `creek deployments --project ${projectSlug}`, description: "List available deployments" },
      ]);
      consola.error(msg);
      process.exit(1);
    }
  },
});

/**
 * Self-host rollback per DESIGN-self-host-state.md §"The Release
 * resource":
 *
 *   creek rollback --host=<name> --to=<seq>
 *
 * Reads the host from ~/.creek/hosts.json (must be pinned via
 * `creek init --adopt` first), resolves If-Match from
 * .creek/local.json (or falls back to a fresh GET), calls
 * POST /v1/apps/{appId}/rollback?to=<seq>, and writes the new rv
 * back to the local cache on success.
 *
 * 412 behaviour: emits a structured error with the daemon's
 * current rv. Does NOT auto-retry unless --bypass-rv is set
 * (DESIGN §"First-party CLI MUST send If-Match": "does NOT
 * auto-retry by default").
 */
async function rollbackSelfHost(
  hostName: string,
  toRaw: string | undefined,
  projectArg: string | undefined,
  bypassRv: boolean,
  jsonMode: boolean,
): Promise<void> {
  if (!toRaw) {
    const msg = "self-host rollback requires --to=<releaseSeq>";
    if (jsonMode) jsonOutput({ ok: false, error: "missing_to", message: msg }, 1, []);
    consola.error(msg);
    process.exit(1);
  }
  const toSeq = Number.parseInt(toRaw, 10);
  if (!Number.isFinite(toSeq) || toSeq <= 0) {
    const msg = `--to must be a positive integer (got "${toRaw}")`;
    if (jsonMode) jsonOutput({ ok: false, error: "bad_to", message: msg }, 1, []);
    consola.error(msg);
    process.exit(1);
  }

  // Resolve host from hosts.json.
  const hostsFile = readHosts();
  const host = findHost(hostsFile, hostName);
  if (!host) {
    const msg = `host "${hostName}" not found in ~/.creek/hosts.json (run \`creek init --adopt=<addr>\` to pin it first)`;
    if (jsonMode) jsonOutput({ ok: false, error: "host_not_pinned", message: msg, host: hostName }, 1, []);
    consola.error(msg);
    process.exit(1);
  }

  // Project name = creekd app ID.
  const cwd = process.cwd();
  const appId = resolveAppId(projectArg, cwd);
  if (!appId) {
    const msg = "no creek.toml in cwd and --project not specified";
    if (jsonMode) jsonOutput({ ok: false, error: "no_project", message: msg }, 1, []);
    consola.error(msg);
    process.exit(1);
  }

  const client = new CreekdClient(host.addr);
  const release = await doRollbackWithIfMatch(client, appId, toSeq, cwd, host.name, bypassRv, jsonMode);

  // The Release wire shape doesn't carry the app's new
  // resourceVersion directly — fetch the envelope to capture it
  // for the local cache. Failure here doesn't roll back the
  // rollback; we just lose cache freshness and the next mutation
  // does a fresh GET. Log and continue.
  try {
    const envelope = await client.getApp(appId);
    recordLastDeploy(cwd, {
      appId,
      host: host.name,
      resourceVersion: envelope.metadata.resourceVersion,
      generation: envelope.metadata.generation,
      at: new Date().toISOString(),
    });
  } catch (e) {
    if (!jsonMode) {
      const msg = e instanceof Error ? e.message : String(e);
      consola.warn(`rollback succeeded but local cache refresh failed: ${msg}`);
    }
  }

  if (jsonMode) {
    jsonOutput({
      ok: true,
      host: host.name,
      app: appId,
      release,
    }, 0, [
      { command: `creek status --host ${host.name}`, description: "Check rollback status" },
    ]);
  }
  consola.success(`Rolled back ${appId} on ${host.name} to release seq ${release.spec.rolledBackFrom}`);
  consola.info(`  new release seq: ${release.spec.releaseSeq} (phase=${release.phase})`);
  if (release.spec.originalArtifactRelease && release.spec.originalArtifactRelease !== release.spec.rolledBackFrom) {
    consola.info(`  original artifact: seq ${release.spec.originalArtifactRelease}`);
  }
}

/**
 * Run the rollback POST with If-Match resolved from the local
 * cache. On 412 mismatch, either re-fetch + retry (when
 * --bypass-rv is set) or surface a structured error so the
 * operator can decide.
 */
async function doRollbackWithIfMatch(
  client: CreekdClient,
  appId: string,
  toSeq: number,
  cwd: string,
  hostName: string,
  bypassRv: boolean,
  jsonMode: boolean,
): Promise<Release> {
  // Read cached rv. If absent, fall back to a fresh GET — better
  // to send a real If-Match (gets a clean 412 on drift) than to
  // emit Warning: 299 "unconditional-write".
  let ifMatch = cachedResourceVersion(cwd, appId, hostName);
  if (!ifMatch) {
    try {
      const envelope = await client.getApp(appId);
      ifMatch = envelope.metadata.resourceVersion;
    } catch (e) {
      // App might not exist on this host yet; let the rollback
      // itself surface 404 release_artifact_pruned with full
      // detail rather than guessing.
      ifMatch = undefined;
    }
  }

  try {
    return await client.rollbackApp(appId, toSeq, ifMatch ? { ifMatch } : {});
  } catch (e) {
    if (e instanceof CreekdResourceVersionMismatchError && bypassRv) {
      // --bypass-rv: auto-refetch current rv and retry exactly
      // once. A second 412 means concurrent writers; that's a
      // real conflict and surfaces normally.
      const envelope = await client.getApp(appId);
      return await client.rollbackApp(appId, toSeq, {
        ifMatch: envelope.metadata.resourceVersion,
      });
    }
    if (e instanceof CreekdResourceVersionMismatchError) {
      const msg = `resource version drifted (sent ${e.attemptedResourceVersion}, current ${e.currentResourceVersion}) — re-run with --bypass-rv to auto-refresh, or refresh the local cache manually`;
      if (jsonMode) {
        jsonOutput({
          ok: false,
          error: "resource_version_mismatch",
          message: msg,
          attemptedResourceVersion: e.attemptedResourceVersion,
          currentResourceVersion: e.currentResourceVersion,
        }, 1, [
          { command: `creek rollback --host ${hostName} --to ${toSeq} --bypass-rv`, description: "Auto-refresh and retry" },
        ]);
      }
      consola.error(msg);
      process.exit(1);
    }
    throw e;
  }
}

/** Resolve creekd app ID — either explicit --project or
 *  parsed from creek.toml. Returns "" when neither is available. */
function resolveAppId(projectArg: string | undefined, cwd: string): string {
  if (projectArg) return projectArg;
  const configPath = join(cwd, "creek.toml");
  if (!existsSync(configPath)) return "";
  return parseConfig(readFileSync(configPath, "utf-8")).project.name;
}
