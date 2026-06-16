import { describe, expect, it } from "vitest";
import { resolveDeployCompat, arrayBufferToBase64 } from "./deploy";
import { base64ToArrayBuffer } from "./deploy-job";

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
