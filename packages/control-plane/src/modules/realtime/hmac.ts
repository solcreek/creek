/**
 * HMAC-SHA256 per-project secret derivation.
 *
 * The realtime master key is shared between control-plane and realtime-worker.
 * Per-project secrets are derived deterministically:
 *   secret = HMAC-SHA256(masterKey, projectSlug)
 *
 * This way:
 * - No need to store per-project secrets
 * - Realtime-worker can validate by recomputing
 * - Each project gets a unique broadcast auth token
 */

/**
 * Derive a per-project realtime secret from the master key.
 * Returns a hex-encoded HMAC-SHA256 string.
 */
export async function deriveRealtimeSecret(
  masterKey: string,
  projectSlug: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(projectSlug),
  );

  // Convert to hex string
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
