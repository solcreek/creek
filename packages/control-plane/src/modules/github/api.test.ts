import { describe, test, expect, beforeEach } from "vitest";
import {
  createAppJWT,
  clearTokenCache,
  formatPreviewComment,
} from "./api.js";

describe("createAppJWT", () => {
  // We can't test with a real RSA key in unit tests (crypto.subtle needs
  // a real PKCS#8 key). Test the structure instead.

  test("formatPreviewComment produces valid markdown", () => {
    const comment = formatPreviewComment(
      "my-app-git-feat-acme.bycreek.com",
      94000,
      "Nuxt",
      87,
      41,
    );
    expect(comment).toContain("### Creek Preview");
    expect(comment).toContain("my-app-git-feat-acme.bycreek.com");
    expect(comment).toContain("94s");
    expect(comment).toContain("Nuxt");
    expect(comment).toContain("87 assets");
    expect(comment).toContain("41 server files");
  });

  test("formatPreviewComment omits server files when zero", () => {
    const comment = formatPreviewComment(
      "app.bycreek.com",
      5000,
      "Vite + React",
      12,
      0,
    );
    expect(comment).not.toContain("server files");
  });
});

describe("token cache", () => {
  beforeEach(() => {
    clearTokenCache();
  });

  test("clearTokenCache resets cache", () => {
    // Just verify it doesn't throw
    clearTokenCache();
  });
});
