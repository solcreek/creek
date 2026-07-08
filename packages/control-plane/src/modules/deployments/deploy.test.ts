import { describe, expect, it } from "vitest";
import { resolveDeployCompat, arrayBufferToBase64 } from "./deploy";
import {
  base64ToArrayBuffer,
  decodeBundleAssets,
  resolveServerFiles,
  deleteStagedBundle,
} from "./deploy-job";
import type { StagedBundle } from "./deploy-job";
import type { Env } from "../../types";

// node:http (statically imported by the Next.js worker) needs nodejs_compat
// — NOT nodejs_compat_v2 — and its server modules auto-enable only at
// compatibility_date >= 2025-09-01. These guard the regression where the
// Next.js default was nodejs_compat_v2 + 2025-03-14 (rejected by WfP).
describe("resolveDeployCompat", () => {
  it("defaults Next.js to nodejs_compat (not v2) at a date >= 2025-09-01", () => {
    const c = resolveDeployCompat("nextjs");
    expect(c.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(c.compatibility_flags).not.toContain("nodejs_compat_v2");
    expect(c.compatibility_date >= "2025-09-01").toBe(true);
  });

  it("defaults non-Next.js to nodejs_compat at the conservative date", () => {
    const c = resolveDeployCompat("vite-react");
    expect(c.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(c.compatibility_date).toBe("2025-03-14");
  });

  it("prefers the bundle-declared date and flags when provided", () => {
    const c = resolveDeployCompat("nextjs", "2026-03-28", ["nodejs_compat"]);
    expect(c.compatibility_date).toBe("2026-03-28");
    expect(c.compatibility_flags).toEqual(["nodejs_compat"]);
  });

  it("treats an empty flags array as unset (uses the default)", () => {
    const c = resolveDeployCompat("nextjs", undefined, []);
    expect(c.compatibility_flags).toEqual(["nodejs_compat"]);
  });
});

// The base64 codec is on the hot path of every deploy. The encoder builds the
// binary string in 32KB chunks (was per-byte concat); the decoder writes a
// pre-allocated typed array. These guard correctness across the risky edges:
// high bytes (>127), the 0x8000 chunk boundary, and empty input.
describe("base64 codec round-trip (deploy hot path)", () => {
  function roundTrip(bytes: Uint8Array): Uint8Array {
    const b64 = arrayBufferToBase64(bytes.buffer as ArrayBuffer);
    return new Uint8Array(base64ToArrayBuffer(b64));
  }

  it("round-trips bytes spanning the full 0..255 range", () => {
    const src = new Uint8Array(256);
    for (let i = 0; i < 256; i++) src[i] = i;
    expect(roundTrip(src)).toEqual(src);
  });

  it("round-trips across the 0x8000 chunk boundary", () => {
    const n = 0x8000 * 2 + 123; // spans 3 chunks, non-aligned tail
    const src = new Uint8Array(n);
    for (let i = 0; i < n; i++) src[i] = (i * 31 + 7) & 0xff;
    const out = roundTrip(src);
    expect(out.length).toBe(n);
    expect(out).toEqual(src);
  });

  it("handles an empty buffer", () => {
    expect(arrayBufferToBase64(new Uint8Array(0).buffer)).toBe("");
    expect(new Uint8Array(base64ToArrayBuffer("")).length).toBe(0);
  });

  it("produces standard base64 (matches a known vector)", () => {
    const src = new TextEncoder().encode("hello, creek");
    expect(arrayBufferToBase64(src.buffer as ArrayBuffer)).toBe("aGVsbG8sIGNyZWVr");
  });
});

describe("decodeBundleAssets (bounded-memory decode)", () => {
  const b64 = (s: string) => arrayBufferToBase64(new TextEncoder().encode(s).buffer as ArrayBuffer);
  const text = (buf: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(buf));

  function makeBundle(
    assets: Record<string, string>,
    serverFiles?: Record<string, string>,
  ): StagedBundle {
    return {
      manifest: { assets: Object.keys(assets), hasWorker: !!serverFiles, entrypoint: null },
      assets,
      ...(serverFiles ? { serverFiles } : {}),
    };
  }

  it("decodes assets to the original bytes", () => {
    const decoded = decodeBundleAssets(
      makeBundle({ "/a.js": b64("alpha"), "/b.css": b64("beta") }),
    );
    expect(text(decoded["/a.js"])).toBe("alpha");
    expect(text(decoded["/b.css"])).toBe("beta");
  });

  it("frees each source base64 string once decoded (the OOM fix)", () => {
    // The contract that keeps the deploy job under the 128MB Worker cap: the
    // parsed base64 must not stay alive alongside the decoded ArrayBuffers.
    const bundle = makeBundle({ "/a.js": b64("alpha"), "/b.js": b64("beta") });
    decodeBundleAssets(bundle);
    for (const v of Object.values(bundle.assets)) expect(v).toBe("");
  });

  it("preserves keys so the caller can still count assets", () => {
    const bundle = makeBundle({ "/a.js": b64("x"), "/b.js": b64("y") });
    decodeBundleAssets(bundle);
    expect(Object.keys(bundle.assets)).toEqual(["/a.js", "/b.js"]);
  });

  it("handles an empty asset map", () => {
    expect(Object.keys(decodeBundleAssets(makeBundle({})))).toEqual([]);
  });
});

describe("resolveServerFiles (binary R2 vs legacy inline)", () => {
  const b64 = (s: string) => arrayBufferToBase64(new TextEncoder().encode(s).buffer as ArrayBuffer);
  const text = (buf: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(buf));
  const bundleBase = (extra: Partial<StagedBundle>): StagedBundle => ({
    manifest: { assets: [], hasWorker: true, entrypoint: null },
    assets: {},
    ...extra,
  });

  it("reads binary server files from R2 by name (the memory-safe path)", async () => {
    // Models the new CLI: server files staged as separate binary R2 objects,
    // listed in serverFileNames — read as ArrayBuffers, never base64/JSON.
    const store: Record<string, ArrayBuffer> = {
      "bundles/dep1-server/worker.js": new TextEncoder().encode("worker-bytes")
        .buffer as ArrayBuffer,
      "bundles/dep1-server/q.wasm": new TextEncoder().encode("wasm-bytes").buffer as ArrayBuffer,
    };
    const env = {
      ASSETS: {
        get: async (key: string) => (store[key] ? { arrayBuffer: async () => store[key] } : null),
      },
    } as unknown as Env;

    const out = await resolveServerFiles(
      env,
      "dep1",
      bundleBase({ serverFileNames: ["worker.js", "q.wasm"] }),
    );
    expect(text(out!["worker.js"])).toBe("worker-bytes");
    expect(text(out!["q.wasm"])).toBe("wasm-bytes");
  });

  it("throws (uploading-stage) when a named server file is missing from R2", async () => {
    const env = { ASSETS: { get: async () => null } } as unknown as Env;
    await expect(
      resolveServerFiles(env, "dep1", bundleBase({ serverFileNames: ["worker.js"] })),
    ).rejects.toThrow(/missing from staging/);
  });

  it("rejects an unsafe serverFileNames entry before touching R2 (bundle route can't be trusted)", async () => {
    let got: string | undefined;
    const env = {
      ASSETS: { get: async (k: string) => ((got = k), null) },
    } as unknown as Env;
    await expect(
      resolveServerFiles(env, "dep1", bundleBase({ serverFileNames: ["../../evil"] })),
    ).rejects.toThrow(/Invalid server file name/);
    expect(got).toBeUndefined(); // never read from R2
  });

  it("decodes legacy inline base64 serverFiles (older CLI) and frees them", async () => {
    const bundle = bundleBase({ serverFiles: { "worker.js": b64("legacy-worker") } });
    const env = {} as unknown as Env; // R2 not touched on the inline path
    const out = await resolveServerFiles(env, "dep1", bundle);
    expect(text(out!["worker.js"])).toBe("legacy-worker");
    expect(bundle.serverFiles!["worker.js"]).toBe(""); // freed
  });

  it("prefers serverFileNames over inline serverFiles, and frees the stray inline base64", async () => {
    const env = {
      ASSETS: {
        get: async () => ({ arrayBuffer: async () => new TextEncoder().encode("from-r2").buffer }),
      },
    } as unknown as Env;
    const bundle = bundleBase({
      serverFileNames: ["worker.js"],
      serverFiles: { "worker.js": b64("inline") },
    });
    const out = await resolveServerFiles(env, "dep1", bundle);
    expect(text(out!["worker.js"])).toBe("from-r2");
    // The stray inline base64 must be cleared so it can't negate the memory win.
    expect(bundle.serverFiles!["worker.js"]).toBe("");
  });

  it("returns undefined for a pure SPA (no worker, no server files)", async () => {
    const env = {} as unknown as Env;
    const spa: StagedBundle = {
      manifest: { assets: ["index.html"], hasWorker: false, entrypoint: null },
      assets: {},
    };
    expect(await resolveServerFiles(env, "dep1", spa)).toBeUndefined();
  });

  it("throws when a worker/SSR bundle staged no server files (no silent SPA fallback)", async () => {
    const env = {} as unknown as Env;
    // hasWorker true but neither serverFileNames nor serverFiles present.
    await expect(resolveServerFiles(env, "dep1", bundleBase({}))).rejects.toThrow(
      /worker\/SSR render but staged no/,
    );
    // Also via renderMode, even if hasWorker were unset.
    const ssr: StagedBundle = {
      manifest: { assets: [], hasWorker: false, entrypoint: null, renderMode: "ssr" },
      assets: {},
    };
    await expect(resolveServerFiles(env, "dep1", ssr)).rejects.toThrow(/missing/);
  });
});

describe("deleteStagedBundle (staging cleanup)", () => {
  it("deletes the bundle JSON and every listed binary server file", async () => {
    const deleted: string[] = [];
    const env = {
      ASSETS: {
        list: async ({ prefix }: { prefix: string }) => ({
          objects: [{ key: `${prefix}worker.js` }, { key: `${prefix}q.wasm` }],
        }),
        delete: async (key: string) => void deleted.push(key),
      },
    } as unknown as Env;
    await deleteStagedBundle(env, "dep9");
    expect(deleted.sort()).toEqual([
      "bundles/dep9-server/q.wasm",
      "bundles/dep9-server/worker.js",
      "bundles/dep9.json",
    ]);
  });

  it("still deletes the bundle JSON when the server-file listing throws", async () => {
    const deleted: string[] = [];
    const env = {
      ASSETS: {
        list: async () => {
          throw new Error("R2 list down");
        },
        delete: async (key: string) => void deleted.push(key),
      },
    } as unknown as Env;
    await expect(deleteStagedBundle(env, "dep9")).resolves.toBeUndefined();
    expect(deleted).toEqual(["bundles/dep9.json"]);
  });

  it("never rejects even if a delete fails (best-effort)", async () => {
    const env = {
      ASSETS: {
        list: async () => ({ objects: [{ key: "bundles/x-server/w.js" }] }),
        delete: async () => {
          throw new Error("delete failed");
        },
      },
    } as unknown as Env;
    await expect(deleteStagedBundle(env, "x")).resolves.toBeUndefined();
  });
});
