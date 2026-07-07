import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hostsPath,
  readHosts,
  writeHosts,
  upsertHost,
  findHost,
  HOSTS_SCHEMA_VERSION,
  type HostsFile,
  type HostEntry,
} from "./hosts.js";

/** Sandbox the hostsPath() resolver against a tmp dir for each test. */
function withTmpHostsPath(): { dir: string; path: string } {
  const dir = join(tmpdir(), "creek-hosts-test-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "hosts.json");
  process.env.CREEK_HOSTS_PATH = path;
  return { dir, path };
}

function cleanup(dir: string) {
  delete process.env.CREEK_HOSTS_PATH;
  rmSync(dir, { recursive: true, force: true });
}

describe("hostsPath", () => {
  it("honours CREEK_HOSTS_PATH override", () => {
    process.env.CREEK_HOSTS_PATH = "/tmp/some-fake/hosts.json";
    expect(hostsPath()).toBe("/tmp/some-fake/hosts.json");
    delete process.env.CREEK_HOSTS_PATH;
  });
  it("defaults to ~/.creek/hosts.json when override unset", () => {
    delete process.env.CREEK_HOSTS_PATH;
    expect(hostsPath()).toMatch(/\.creek\/hosts\.json$/);
  });
});

describe("readHosts", () => {
  let env: { dir: string; path: string };
  beforeEach(() => {
    env = withTmpHostsPath();
  });
  afterEach(() => cleanup(env.dir));

  it("returns empty file when path does not exist", () => {
    const got = readHosts();
    expect(got).toEqual({ schemaVersion: HOSTS_SCHEMA_VERSION, hosts: [] });
  });

  it("reads back the canonical shape", () => {
    const want: HostsFile = {
      schemaVersion: HOSTS_SCHEMA_VERSION,
      fleetLabel: "test",
      hosts: [
        {
          name: "a",
          addr: "127.0.0.1:9080",
          creekdPubkey: "AAAA",
          fingerprint: "sha256:dead",
          lastSeen: "2026-05-24T00:00:00Z",
        },
      ],
    };
    writeFileSync(env.path, JSON.stringify(want));
    expect(readHosts()).toEqual(want);
  });

  it("rejects unknown schemaVersion", () => {
    writeFileSync(env.path, JSON.stringify({ schemaVersion: 99, hosts: [] }));
    expect(() => readHosts()).toThrow(/unsupported schemaVersion 99/);
  });

  it("rejects missing schemaVersion", () => {
    writeFileSync(env.path, JSON.stringify({ hosts: [] }));
    expect(() => readHosts()).toThrow(/missing schemaVersion/);
  });

  it("rejects non-array hosts field", () => {
    writeFileSync(env.path, JSON.stringify({ schemaVersion: 1, hosts: "nope" }));
    expect(() => readHosts()).toThrow(/hosts is not an array/);
  });
});

describe("writeHosts", () => {
  let env: { dir: string; path: string };
  beforeEach(() => {
    env = withTmpHostsPath();
  });
  afterEach(() => cleanup(env.dir));

  it("writes the file atomically — no tmp leftover on success", () => {
    const file: HostsFile = {
      schemaVersion: HOSTS_SCHEMA_VERSION,
      hosts: [],
    };
    writeHosts(file);
    expect(existsSync(env.path)).toBe(true);
    expect(existsSync(env.path + ".tmp")).toBe(false);
  });

  it("rejects schemaVersion mismatch in input", () => {
    expect(() => writeHosts({ schemaVersion: 99, hosts: [] })).toThrow(/schemaVersion/);
  });

  it("creates parent dir if missing", () => {
    rmSync(env.dir, { recursive: true, force: true });
    writeHosts({ schemaVersion: HOSTS_SCHEMA_VERSION, hosts: [] });
    expect(existsSync(env.path)).toBe(true);
  });

  it("round-trips through readHosts", () => {
    const file: HostsFile = {
      schemaVersion: HOSTS_SCHEMA_VERSION,
      fleetLabel: "rt",
      hosts: [
        {
          name: "h",
          addr: "host:9080",
          creekdPubkey: "K",
          fingerprint: "sha256:f",
          lastSeen: "t",
        },
      ],
    };
    writeHosts(file);
    expect(readHosts()).toEqual(file);
  });
});

describe("upsertHost", () => {
  const base: HostsFile = {
    schemaVersion: HOSTS_SCHEMA_VERSION,
    hosts: [
      { name: "a", addr: "addr-a", creekdPubkey: "PA", fingerprint: "sha256:a", lastSeen: "t1" },
      { name: "b", addr: "addr-b", creekdPubkey: "PB", fingerprint: "sha256:b", lastSeen: "t1" },
    ],
  };

  it("appends a new entry", () => {
    const entry: HostEntry = {
      name: "c",
      addr: "x",
      creekdPubkey: "C",
      fingerprint: "sha256:c",
      lastSeen: "t2",
    };
    const next = upsertHost(base, entry);
    expect(next.hosts).toHaveLength(3);
    expect(next.hosts[2]).toEqual(entry);
  });

  it("replaces by name in place (preserves order)", () => {
    const updated: HostEntry = {
      name: "a",
      addr: "addr-a-new",
      creekdPubkey: "PA2",
      fingerprint: "sha256:a2",
      lastSeen: "t3",
    };
    const next = upsertHost(base, updated);
    expect(next.hosts).toHaveLength(2);
    expect(next.hosts[0]).toEqual(updated);
    expect(next.hosts[1]?.name).toBe("b"); // unchanged
  });

  it("does NOT mutate input", () => {
    const before = JSON.parse(JSON.stringify(base));
    upsertHost(base, {
      name: "z",
      addr: "z",
      creekdPubkey: "Z",
      fingerprint: "sha256:z",
      lastSeen: "t",
    });
    expect(base).toEqual(before);
  });
});

describe("findHost", () => {
  const file: HostsFile = {
    schemaVersion: HOSTS_SCHEMA_VERSION,
    hosts: [{ name: "a", addr: "x", creekdPubkey: "K", fingerprint: "sha256:a", lastSeen: "t" }],
  };
  it("returns the entry by name", () => {
    expect(findHost(file, "a")?.addr).toBe("x");
  });
  it("returns undefined when missing", () => {
    expect(findHost(file, "ghost")).toBeUndefined();
  });
});
