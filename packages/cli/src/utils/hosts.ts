/**
 * Laptop-side multi-host registry. Schema per DESIGN-self-host-state.md
 * §"Multi-host CLI state":
 *
 *   ~/.creek/hosts.json
 *   {
 *     "schemaVersion": 1,
 *     "fleetLabel": "...",
 *     "hosts": [{ name, id, ip, creekdPubkey, ... }]
 *   }
 *
 * 0.0.x ships only the fields needed for TOFU hostkey pinning
 * (name, addr, creekdPubkey + fingerprint, lastSeen). The optional
 * agePubkey / provider / sshKeyFingerprint / region fields land in
 * 0.1.0 when the recovery kit + capstan provisioning paths arrive.
 *
 * Writes are atomic via tmp + rename (DESIGN line 550). flock is
 * deferred — 0.0.x is single-user dogfood; concurrent writers from
 * the same laptop are not yet a concern.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HOSTS_SCHEMA_VERSION = 1;

/** One pinned creekd host entry. */
export interface HostEntry {
  /** Operator-chosen short name. Unique within the file. */
  name: string;
  /** addr is host:port or just host. Where the admin API listens. */
  addr: string;
  /** ed25519 public key bytes, base64-encoded. From GET /v1/hostkey. */
  creekdPubkey: string;
  /** "sha256:<hex>" of the pubkey bytes — what the operator pastes / verifies. */
  fingerprint: string;
  /** RFC3339 timestamp of last successful contact. Updated on each verify. */
  lastSeen: string;
  /** Optional 0.0.x — populated in 0.1.0 by the recovery-kit flow. */
  agePubkey?: string;
}

/** Top-level shape of ~/.creek/hosts.json. */
export interface HostsFile {
  schemaVersion: number;
  /** Operator-chosen label for the whole fleet. Optional. */
  fleetLabel?: string;
  hosts: HostEntry[];
}

/** Resolve ~/.creek/hosts.json. Exposed so tests can override via env. */
export function hostsPath(): string {
  return process.env.CREEK_HOSTS_PATH ?? join(homedir(), ".creek", "hosts.json");
}

/** Read hosts.json. Returns an empty file shape if absent. */
export function readHosts(path = hostsPath()): HostsFile {
  if (!existsSync(path)) {
    return { schemaVersion: HOSTS_SCHEMA_VERSION, hosts: [] };
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as Partial<HostsFile>;
  if (typeof parsed.schemaVersion !== "number") {
    throw new Error(`hosts.json: missing schemaVersion`);
  }
  if (parsed.schemaVersion !== HOSTS_SCHEMA_VERSION) {
    throw new Error(
      `hosts.json: unsupported schemaVersion ${parsed.schemaVersion} ` +
        `(want ${HOSTS_SCHEMA_VERSION})`,
    );
  }
  if (!Array.isArray(parsed.hosts)) {
    throw new Error(`hosts.json: hosts is not an array`);
  }
  return parsed as HostsFile;
}

/**
 * Write hosts.json atomically — write to <path>.tmp, then rename
 * over the destination. The rename is atomic on POSIX filesystems;
 * a reader sees either the old file or the new file, never a
 * half-written one. Crash during write leaves the tmp behind but
 * never corrupts hosts.json itself.
 */
export function writeHosts(file: HostsFile, path = hostsPath()): void {
  if (file.schemaVersion !== HOSTS_SCHEMA_VERSION) {
    throw new Error(`writeHosts: schemaVersion ${file.schemaVersion} != ${HOSTS_SCHEMA_VERSION}`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Insert or replace a host by name. Returns a new HostsFile —
 * does not mutate the input. Pure so it's trivially testable.
 *
 * Replacement semantics: same `name` overwrites. Same fingerprint
 * with a different name is allowed (operator may legitimately
 * register the same host under two labels). Re-pinning with a
 * NEW fingerprint for an existing name is a TOFU rotation — the
 * caller is responsible for confirming this is intentional; the
 * util just records it.
 */
export function upsertHost(file: HostsFile, entry: HostEntry): HostsFile {
  const idx = file.hosts.findIndex((h) => h.name === entry.name);
  const next = file.hosts.slice();
  if (idx >= 0) {
    next[idx] = entry;
  } else {
    next.push(entry);
  }
  return { ...file, hosts: next };
}

/** Find a host by name. */
export function findHost(file: HostsFile, name: string): HostEntry | undefined {
  return file.hosts.find((h) => h.name === name);
}
