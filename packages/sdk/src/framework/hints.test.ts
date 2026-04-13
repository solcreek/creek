import { describe, test, expect } from "vitest";
import { detectEmdash, resolveDeployHint } from "./hints.js";

describe("detectEmdash", () => {
  test("detects bare emdash dep", () => {
    const hint = detectEmdash({ dependencies: { emdash: "^0.3", astro: "^6" } });
    expect(hint).not.toBeNull();
    expect(hint?.adminPath).toBe("/_emdash/admin");
    expect(hint?.warnings?.[0]).toMatch(/404/i);
  });

  test("detects scoped @emdash-cms/* dep", () => {
    const hint = detectEmdash({
      dependencies: { "@emdash-cms/cloudflare": "workspace:*", astro: "^6" },
    });
    expect(hint?.adminPath).toBe("/_emdash/admin");
  });

  test("detects via devDependencies too", () => {
    const hint = detectEmdash({
      devDependencies: { "@emdash-cms/admin": "^0.3" },
    });
    expect(hint).not.toBeNull();
  });

  test("returns null when no emdash deps", () => {
    expect(detectEmdash({ dependencies: { astro: "^6", react: "^18" } })).toBeNull();
  });

  test("returns null for empty package.json", () => {
    expect(detectEmdash({})).toBeNull();
  });

  test("does not match unrelated deps that happen to contain 'emdash' substring", () => {
    // Guard against false positives from substring matching instead of
    // name-prefix matching.
    expect(
      detectEmdash({ dependencies: { "not-emdash-compat": "^1" } }),
    ).toBeNull();
  });
});

describe("resolveDeployHint", () => {
  test("returns emdash hint when detected", () => {
    expect(resolveDeployHint({ dependencies: { emdash: "^0.3" } })).not.toBeNull();
  });

  test("returns null for non-matching project", () => {
    expect(resolveDeployHint({ dependencies: { astro: "^6" } })).toBeNull();
  });
});
