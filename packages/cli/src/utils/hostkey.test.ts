import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  fetchHostkey,
  validateHostkey,
  computeFingerprint,
  parsePastedFingerprint,
  normalizeAdminAddr,
  HostkeyResponseError,
} from "./hostkey.js";

/** Build a sample {publicKey, fingerprint} pair that matches the
 *  validateHostkey self-check. */
function makeKeyPair(): { publicKey: string; fingerprint: string } {
  const raw = Buffer.from("0123456789abcdef0123456789abcdef"); // 32 bytes
  const publicKey = raw.toString("base64");
  const fingerprint = "sha256:" + createHash("sha256").update(raw).digest("hex");
  return { publicKey, fingerprint };
}

describe("computeFingerprint", () => {
  it("matches sha256(base64-decoded(publicKey))", () => {
    const { publicKey, fingerprint } = makeKeyPair();
    expect(computeFingerprint(publicKey)).toBe(fingerprint);
  });
});

describe("validateHostkey", () => {
  it("accepts a well-formed response", () => {
    const { publicKey, fingerprint } = makeKeyPair();
    expect(validateHostkey({ algorithm: "ed25519", publicKey, fingerprint })).toEqual({
      algorithm: "ed25519",
      publicKey,
      fingerprint,
    });
  });

  it("rejects unknown algorithm", () => {
    expect(() =>
      validateHostkey({ algorithm: "rsa" as never, publicKey: "x", fingerprint: "sha256:y" }),
    ).toThrow(HostkeyResponseError);
  });

  it("rejects missing publicKey", () => {
    const { fingerprint } = makeKeyPair();
    expect(() => validateHostkey({ algorithm: "ed25519", fingerprint })).toThrow(
      /missing publicKey/,
    );
  });

  it("rejects malformed fingerprint prefix", () => {
    const { publicKey } = makeKeyPair();
    expect(() =>
      validateHostkey({ algorithm: "ed25519", publicKey, fingerprint: "md5:abc" }),
    ).toThrow(/malformed fingerprint/);
  });

  it("rejects fingerprint that does not match the publicKey bytes — defends against a buggy / malicious daemon claiming a different fingerprint than the bytes it returned", () => {
    const { publicKey } = makeKeyPair();
    const wrong = "sha256:" + "0".repeat(64);
    expect(() => validateHostkey({ algorithm: "ed25519", publicKey, fingerprint: wrong })).toThrow(
      /does not match sha256\(publicKey\)/,
    );
  });
});

describe("parsePastedFingerprint", () => {
  it("accepts canonical lowercase form", () => {
    const fp = "sha256:" + "a".repeat(64);
    expect(parsePastedFingerprint(fp)).toBe(fp);
  });

  it("trims surrounding whitespace", () => {
    const fp = "sha256:" + "b".repeat(64);
    expect(parsePastedFingerprint("   " + fp + "\n")).toBe(fp);
  });

  it("lowercases mixed-case hex (paper bundle prints upper sometimes)", () => {
    const upper = "sha256:" + "A".repeat(64);
    const lower = "sha256:" + "a".repeat(64);
    expect(parsePastedFingerprint(upper)).toBe(lower);
  });

  it("rejects wrong prefix", () => {
    expect(() => parsePastedFingerprint("md5:" + "a".repeat(32))).toThrow();
  });

  it("rejects wrong hex length", () => {
    expect(() => parsePastedFingerprint("sha256:" + "a".repeat(63))).toThrow();
    expect(() => parsePastedFingerprint("sha256:" + "a".repeat(65))).toThrow();
  });

  it("rejects non-hex characters", () => {
    expect(() => parsePastedFingerprint("sha256:" + "g".repeat(64))).toThrow();
  });
});

describe("normalizeAdminAddr", () => {
  it("adds http:// when scheme missing", () => {
    expect(normalizeAdminAddr("127.0.0.1:9080")).toBe("http://127.0.0.1:9080");
  });
  it("preserves existing http://", () => {
    expect(normalizeAdminAddr("http://h.dev:9080")).toBe("http://h.dev:9080");
  });
  it("preserves existing https://", () => {
    expect(normalizeAdminAddr("https://h.dev")).toBe("https://h.dev");
  });
  it("strips trailing slashes", () => {
    expect(normalizeAdminAddr("h.dev:9080///")).toBe("http://h.dev:9080");
  });
});

describe("fetchHostkey", () => {
  it("returns the validated body on 200", async () => {
    const { publicKey, fingerprint } = makeKeyPair();
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ algorithm: "ed25519", publicKey, fingerprint }),
    })) as unknown as typeof fetch;

    const got = await fetchHostkey("127.0.0.1:9080", fakeFetch);
    expect(got.fingerprint).toBe(fingerprint);
  });

  it("surfaces 503 with a hint that hostkey is not yet initialised", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ code: "internal", error: "hostkey not initialised" }),
    })) as unknown as typeof fetch;

    await expect(fetchHostkey("h:9080", fakeFetch)).rejects.toThrow(/503.*not yet initialised/);
  });

  it("surfaces other non-2xx as plain error", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    })) as unknown as typeof fetch;

    await expect(fetchHostkey("h:9080", fakeFetch)).rejects.toThrow(/returned 500/);
  });

  it("propagates validateHostkey failures (e.g. fingerprint mismatch)", async () => {
    const { publicKey } = makeKeyPair();
    const wrongFingerprint = "sha256:" + "0".repeat(64);
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ algorithm: "ed25519", publicKey, fingerprint: wrongFingerprint }),
    })) as unknown as typeof fetch;

    await expect(fetchHostkey("h:9080", fakeFetch)).rejects.toThrow(/does not match sha256/);
  });
});
