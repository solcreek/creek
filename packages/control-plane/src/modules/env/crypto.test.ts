import { describe, test, expect } from "vitest";
import { encrypt, decrypt, mask } from "./crypto.js";

const KEY = "test-encryption-key-for-creek";

describe("encrypt / decrypt", () => {
  test("round-trip: decrypt(encrypt(x)) === x", async () => {
    const plaintext = "postgres://user:pass@host/db";
    const encrypted = await encrypt(plaintext, KEY);
    const decrypted = await decrypt(encrypted, KEY);
    expect(decrypted).toBe(plaintext);
  });

  test("encrypted value is different from plaintext", async () => {
    const plaintext = "my-secret-value";
    const encrypted = await encrypt(plaintext, KEY);
    expect(encrypted).not.toBe(plaintext);
  });

  test("same plaintext produces different ciphertexts (random IV)", async () => {
    const plaintext = "same-value";
    const a = await encrypt(plaintext, KEY);
    const b = await encrypt(plaintext, KEY);
    expect(a).not.toBe(b);
  });

  test("wrong key fails to decrypt", async () => {
    const encrypted = await encrypt("secret", KEY);
    await expect(decrypt(encrypted, "wrong-key")).rejects.toThrow();
  });

  test("handles empty string", async () => {
    const encrypted = await encrypt("", KEY);
    const decrypted = await decrypt(encrypted, KEY);
    expect(decrypted).toBe("");
  });

  test("handles unicode", async () => {
    const plaintext = "你好世界 🌍";
    const encrypted = await encrypt(plaintext, KEY);
    const decrypted = await decrypt(encrypted, KEY);
    expect(decrypted).toBe(plaintext);
  });
});

describe("mask", () => {
  test("masks long values", () => {
    expect(mask("DATABASE_URL")).toBe("DATA****");
  });

  test("masks short values", () => {
    expect(mask("KEY")).toBe("****");
  });

  test("masks exactly 4 chars", () => {
    expect(mask("ABCD")).toBe("****");
  });
});
