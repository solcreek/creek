import { afterEach, describe, expect, it, vi } from "vitest";
import { secretEqual } from "./secret-equal";

describe("secretEqual", () => {
  afterEach(() => vi.restoreAllMocks());

  it("matches only the identical secret", () => {
    expect(secretEqual("s3cret-value", "s3cret-value")).toBe(true);
    expect(secretEqual("s3cret-valuf", "s3cret-value")).toBe(false);
    expect(secretEqual("s3cret", "s3cret-value")).toBe(false);
  });

  it("never authorizes when either side is missing or empty", () => {
    expect(secretEqual(undefined, undefined)).toBe(false);
    expect(secretEqual("", "")).toBe(false);
    expect(secretEqual(null, "x")).toBe(false);
    expect(secretEqual("x", undefined)).toBe(false);
  });

  it("uses the runtime's crypto.subtle.timingSafeEqual when it exists", () => {
    const timingSafeEqual = vi.fn(() => true);
    Object.defineProperty(crypto.subtle, "timingSafeEqual", {
      value: timingSafeEqual,
      configurable: true,
    });
    try {
      expect(secretEqual("abc", "abd")).toBe(true); // the runtime's answer wins
      expect(timingSafeEqual).toHaveBeenCalledOnce();
    } finally {
      delete (crypto.subtle as { timingSafeEqual?: unknown }).timingSafeEqual;
    }
  });
});
