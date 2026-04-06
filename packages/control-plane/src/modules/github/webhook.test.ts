import { describe, test, expect } from "vitest";
import { verifyWebhookSignature, parseWebhookHeaders } from "./webhook.js";

const SECRET = "test-webhook-secret";

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return "sha256=" + [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifyWebhookSignature", () => {
  test("passes for valid signature", async () => {
    const payload = '{"action":"created"}';
    const signature = await sign(payload, SECRET);
    expect(await verifyWebhookSignature(payload, signature, SECRET)).toBe(true);
  });

  test("fails for tampered payload", async () => {
    const signature = await sign('{"action":"created"}', SECRET);
    expect(await verifyWebhookSignature('{"action":"deleted"}', signature, SECRET)).toBe(false);
  });

  test("fails for wrong secret", async () => {
    const payload = '{"action":"created"}';
    const signature = await sign(payload, "wrong-secret");
    expect(await verifyWebhookSignature(payload, signature, SECRET)).toBe(false);
  });

  test("fails for null signature", async () => {
    expect(await verifyWebhookSignature("{}", null, SECRET)).toBe(false);
  });

  test("fails for signature without sha256= prefix", async () => {
    expect(await verifyWebhookSignature("{}", "invalid-format", SECRET)).toBe(false);
  });

  test("fails for empty signature", async () => {
    expect(await verifyWebhookSignature("{}", "", SECRET)).toBe(false);
  });
});

describe("parseWebhookHeaders", () => {
  test("extracts all headers", () => {
    const headers = new Headers({
      "X-GitHub-Event": "push",
      "X-GitHub-Delivery": "abc-123",
      "X-Hub-Signature-256": "sha256=xxx",
    });
    const result = parseWebhookHeaders(headers);
    expect(result.event).toBe("push");
    expect(result.deliveryId).toBe("abc-123");
    expect(result.signature).toBe("sha256=xxx");
  });

  test("returns null for missing headers", () => {
    const result = parseWebhookHeaders(new Headers());
    expect(result.event).toBeNull();
    expect(result.deliveryId).toBeNull();
    expect(result.signature).toBeNull();
  });
});
