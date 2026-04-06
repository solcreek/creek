/**
 * GitHub webhook endpoint — receives events from the GitHub App.
 * Unauthenticated (GitHub sends these, not users). Verified via HMAC-SHA256.
 */

import type { Context } from "hono";
import type { Env } from "../../types.js";

export type WebhookEvent = "push" | "pull_request" | "installation" | "installation_repositories";

export interface WebhookResult {
  event: string;
  action?: string;
  handled: boolean;
}

/**
 * Verify the HMAC-SHA256 signature of a GitHub webhook payload.
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature || !signature.startsWith("sha256=")) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = "sha256=" + [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return signature === expected;
}

/**
 * Parse a GitHub webhook delivery into structured event info.
 */
export function parseWebhookHeaders(headers: Headers): {
  event: string | null;
  deliveryId: string | null;
  signature: string | null;
} {
  return {
    event: headers.get("X-GitHub-Event"),
    deliveryId: headers.get("X-GitHub-Delivery"),
    signature: headers.get("X-Hub-Signature-256"),
  };
}
