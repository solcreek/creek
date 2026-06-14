import { describe, expect, it } from "vitest";
import { resolveDeployCompat } from "./deploy";

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
