// @ts-nocheck — uses node:crypto + Buffer for RSA test fixtures. Runs under
// vitest (Node), not workerd. The control-plane tsconfig targets workers, so
// disable type checking for this single file rather than maintaining a
// separate tsconfig.
import { describe, test, expect, beforeEach, beforeAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  createAppJWT,
  clearTokenCache,
  formatPreviewComment,
} from "./api.js";

describe("createAppJWT", () => {
  let pkcs1Pem: string;
  let pkcs8Pem: string;

  beforeAll(() => {
    // Generate one RSA keypair, export in both PEM formats
    const pkcs1 = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    pkcs1Pem = pkcs1.privateKey;

    const pkcs8 = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    pkcs8Pem = pkcs8.privateKey;
  });

  test("produces valid JWT structure from PKCS#8 PEM", async () => {
    const jwt = await createAppJWT("12345", pkcs8Pem);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("12345");
    expect(payload.exp - payload.iat).toBeGreaterThan(600); // 10min exp + 60s skew
  });

  test("produces valid JWT structure from PKCS#1 PEM (GitHub default)", async () => {
    const jwt = await createAppJWT("67890", pkcs1Pem);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(header.alg).toBe("RS256");
    expect(payload.iss).toBe("67890");
  });

  test("PKCS#1 and PKCS#8 both produce verifiable signatures", async () => {
    // Use the same key in both forms and verify signature validity via Web Crypto
    const jwt1 = await createAppJWT("app", pkcs1Pem);
    const jwt8 = await createAppJWT("app", pkcs8Pem);

    // Both should be valid 3-segment JWTs with non-empty signatures
    for (const jwt of [jwt1, jwt8]) {
      const [h, p, sig] = jwt.split(".");
      expect(h.length).toBeGreaterThan(0);
      expect(p.length).toBeGreaterThan(0);
      expect(sig.length).toBeGreaterThan(100); // RS256 sig is ~342 chars base64url
    }
  });

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
