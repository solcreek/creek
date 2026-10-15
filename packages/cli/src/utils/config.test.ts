import { describe, expect, it } from "vitest";
import { sameApiUrl } from "./config.js";

describe("sameApiUrl", () => {
  it.each([
    ["a trailing slash", "https://api.creek.dev/", "https://api.creek.dev"],
    ["host case", "https://API.Creek.dev", "https://api.creek.dev"],
    ["the scheme's default port", "https://api.creek.dev:443", "https://api.creek.dev"],
    ["a path's trailing slashes", "https://example.com/creek//", "https://example.com/creek"],
  ])("ignores %s", (_, a, b) => {
    expect(sameApiUrl(a, b)).toBe(true);
  });

  it.each([
    ["a suffixed host", "https://api.creek.dev.evil.com", "https://api.creek.dev"],
    ["another scheme", "http://api.creek.dev", "https://api.creek.dev"],
    ["another port", "https://api.creek.dev:8443", "https://api.creek.dev"],
    ["another path", "https://example.com/a", "https://example.com/b"],
  ])("tells apart %s", (_, a, b) => {
    expect(sameApiUrl(a, b)).toBe(false);
  });
});
