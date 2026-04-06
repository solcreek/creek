import { describe, test, expect } from "vitest";
import { validateHostname } from "./validation.js";

describe("validateHostname", () => {
  // ── Valid hostnames ──

  test("accepts simple subdomain", () => {
    expect(validateHostname("app.example.com")).toEqual({ ok: true });
  });

  test("accepts deep subdomain", () => {
    expect(validateHostname("api.staging.example.com")).toEqual({ ok: true });
  });

  test("accepts hyphenated subdomain", () => {
    expect(validateHostname("my-app.example.com")).toEqual({ ok: true });
  });

  test("accepts numeric subdomain", () => {
    expect(validateHostname("123.example.com")).toEqual({ ok: true });
  });

  test("accepts two-letter TLD", () => {
    expect(validateHostname("app.example.io")).toEqual({ ok: true });
  });

  test("accepts internationalized domain (punycode)", () => {
    expect(validateHostname("xn--nxasmq6b.example.com")).toEqual({ ok: true });
  });

  test("accepts bare domain", () => {
    expect(validateHostname("example.com")).toEqual({ ok: true });
  });

  // ── Blocked hostnames ──

  test("rejects localhost", () => {
    const result = validateHostname("localhost");
    expect(result.ok).toBe(false);
  });

  test("rejects subdomain of localhost", () => {
    const result = validateHostname("app.localhost");
    expect(result.ok).toBe(false);
  });

  test("rejects IPv4 address", () => {
    const result = validateHostname("192.168.1.1");
    expect(result.ok).toBe(false);
    expect((result as any).message).toContain("IP addresses");
  });

  test("rejects 127.0.0.1", () => {
    expect(validateHostname("127.0.0.1").ok).toBe(false);
  });

  test("rejects *.bycreek.com", () => {
    const result = validateHostname("evil.bycreek.com");
    expect(result.ok).toBe(false);
    expect((result as any).message).toContain("reserved");
  });

  test("rejects bycreek.com itself", () => {
    expect(validateHostname("bycreek.com").ok).toBe(false);
  });

  test("rejects *.creek.dev", () => {
    expect(validateHostname("my-app.creek.dev").ok).toBe(false);
  });

  test("rejects *.creeksandbox.com", () => {
    expect(validateHostname("test.creeksandbox.com").ok).toBe(false);
  });

  // ── Invalid format ──

  test("rejects empty string", () => {
    expect(validateHostname("").ok).toBe(false);
  });

  test("rejects single label (no dot)", () => {
    const result = validateHostname("example");
    expect(result.ok).toBe(false);
    expect((result as any).message).toContain("must include a domain");
  });

  test("rejects hostname over 253 chars", () => {
    const long = "a".repeat(250) + ".com";
    expect(validateHostname(long).ok).toBe(false);
    expect((validateHostname(long) as any).message).toContain("maximum length");
  });

  test("rejects hostname with uppercase", () => {
    // Hostnames should be lowercased before validation
    expect(validateHostname("App.Example.COM").ok).toBe(false);
  });

  test("rejects hostname starting with hyphen", () => {
    expect(validateHostname("-app.example.com").ok).toBe(false);
  });

  test("rejects hostname with spaces", () => {
    expect(validateHostname("my app.example.com").ok).toBe(false);
  });

  test("rejects hostname with underscores", () => {
    expect(validateHostname("my_app.example.com").ok).toBe(false);
  });

  test("rejects hostname ending with dot", () => {
    expect(validateHostname("app.example.com.").ok).toBe(false);
  });

  test("rejects label over 63 chars", () => {
    const longLabel = "a".repeat(64) + ".example.com";
    expect(validateHostname(longLabel).ok).toBe(false);
  });
});
