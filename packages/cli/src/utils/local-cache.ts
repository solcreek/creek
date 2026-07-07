/**
 * Project-local cache of the laptop's view of creekd's state.
 *
 * Lives at `<project>/.creek/local.json` and is the canonical
 * source for the `If-Match` header per DESIGN-self-host-state.md
 * §"First-party CLI MUST send If-Match" (line 230-232):
 *
 *   "The creek CLI ... MUST send If-Match on every mutating call,
 *    sourced from .creek/local.json.lastDeploy.resourceVersion."
 *
 * Schema is intentionally narrow in 0.0.x:
 *   {
 *     "schemaVersion": 1,
 *     "lastDeploy": {
 *       "appId": "...",
 *       "host": "...",       // hosts.json name; "" for default loopback
 *       "resourceVersion": "<opaque>",
 *       "generation": <int>,
 *       "at": "RFC3339"
 *     }
 *   }
 *
 * Writes are atomic (tmp + rename) to match the hosts.json
 * convention; corrupt-then-crash leaves the file untouched.
 *
 * NOTE: this is per-project state, NOT per-host. Multi-host
 * deploys of the same project use a single lastDeploy slot —
 * switching --host between deploys invalidates the cache and
 * triggers a fresh GET to re-seed. This is intentional: the cache
 * is a hot path optimisation, not authoritative — the daemon's
 * current rv is always the truth.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOCAL_SCHEMA_VERSION = 1;

/** Snapshot of the last successful spec-mutation against creekd. */
export interface LastDeploy {
  appId: string;
  /** hosts.json `name` if any was used; empty string for default localhost. */
  host: string;
  /** Opaque rv string from the wire — clients MUST NOT do arithmetic on it. */
  resourceVersion: string;
  /** Generation as of last successful deploy (sanity check). */
  generation: number;
  /** RFC3339 timestamp of the write. */
  at: string;
}

export interface LocalCacheFile {
  schemaVersion: number;
  lastDeploy?: LastDeploy;
}

/** Resolve <project>/.creek/local.json. */
export function localCachePath(projectRoot: string): string {
  return join(projectRoot, ".creek", "local.json");
}

/** Read the cache. Returns an empty file shape if absent. */
export function readLocalCache(projectRoot: string): LocalCacheFile {
  const path = localCachePath(projectRoot);
  if (!existsSync(path)) {
    return { schemaVersion: LOCAL_SCHEMA_VERSION };
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as Partial<LocalCacheFile>;
  if (typeof parsed.schemaVersion !== "number") {
    throw new Error(`local.json: missing schemaVersion`);
  }
  if (parsed.schemaVersion !== LOCAL_SCHEMA_VERSION) {
    throw new Error(
      `local.json: unsupported schemaVersion ${parsed.schemaVersion} ` +
        `(want ${LOCAL_SCHEMA_VERSION})`,
    );
  }
  return parsed as LocalCacheFile;
}

/** Atomic write — tmp + rename. */
export function writeLocalCache(projectRoot: string, file: LocalCacheFile): void {
  if (file.schemaVersion !== LOCAL_SCHEMA_VERSION) {
    throw new Error(
      `writeLocalCache: schemaVersion ${file.schemaVersion} != ${LOCAL_SCHEMA_VERSION}`,
    );
  }
  const path = localCachePath(projectRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Update lastDeploy after a successful spec mutation. Reads the
 * existing file, replaces lastDeploy, writes back. Convenience
 * wrapper for the most common write pattern.
 */
export function recordLastDeploy(projectRoot: string, lastDeploy: LastDeploy): void {
  const file = readLocalCache(projectRoot);
  writeLocalCache(projectRoot, { ...file, lastDeploy });
}

/**
 * Read the cached rv for an If-Match header. Returns undefined
 * when the cache is empty, when the appId/host don't match
 * (different project or host than last deploy), or when the cache
 * is corrupt. Callers fall back to a fresh GET on undefined.
 */
export function cachedResourceVersion(
  projectRoot: string,
  appId: string,
  host: string,
): string | undefined {
  let file: LocalCacheFile;
  try {
    file = readLocalCache(projectRoot);
  } catch {
    return undefined;
  }
  const last = file.lastDeploy;
  if (!last) return undefined;
  if (last.appId !== appId) return undefined;
  if (last.host !== host) return undefined;
  return last.resourceVersion;
}
