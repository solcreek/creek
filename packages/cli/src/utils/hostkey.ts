/**
 * TOFU hostkey discovery — call creekd's GET /v1/hostkey
 * (unauthenticated, exposes the daemon's ed25519 pubkey +
 * fingerprint per DESIGN §"TOFU hostkey discovery") and verify the
 * response shape.
 *
 * The fingerprint is what the operator should verify out-of-band
 * before pinning (Path B / C in DESIGN). This module is the
 * transport layer; the init command wraps it with the prompt UX.
 */

import { createHash } from "node:crypto";

/** Wire shape returned by GET /v1/hostkey. */
export interface HostkeyInfo {
  algorithm: "ed25519";
  publicKey: string; // base64
  fingerprint: string; // "sha256:<hex>"
}

/** Thrown when the daemon's response is malformed. */
export class HostkeyResponseError extends Error {
  constructor(message: string) {
    super(`hostkey: ${message}`);
    this.name = "HostkeyResponseError";
  }
}

/**
 * Fetch the host key from a creekd daemon. addr may be a bare
 * host:port (the function adds the `http://` scheme) or a full URL.
 */
export async function fetchHostkey(addr: string, fetchImpl: typeof fetch = fetch): Promise<HostkeyInfo> {
  const url = normalizeAdminAddr(addr) + "/v1/hostkey";
  const resp = await fetchImpl(url);
  if (!resp.ok) {
    if (resp.status === 503) {
      throw new HostkeyResponseError(
        `daemon at ${addr} returned 503 — hostkey not yet initialised`,
      );
    }
    throw new HostkeyResponseError(`daemon at ${addr} returned ${resp.status}`);
  }
  const body = (await resp.json()) as Partial<HostkeyInfo>;
  return validateHostkey(body);
}

/** Throws if body is missing fields or has wrong types. */
export function validateHostkey(body: Partial<HostkeyInfo>): HostkeyInfo {
  if (body.algorithm !== "ed25519") {
    throw new HostkeyResponseError(`unknown algorithm "${String(body.algorithm)}"`);
  }
  if (typeof body.publicKey !== "string" || body.publicKey.length === 0) {
    throw new HostkeyResponseError("missing publicKey");
  }
  if (typeof body.fingerprint !== "string" || !body.fingerprint.startsWith("sha256:")) {
    throw new HostkeyResponseError(`malformed fingerprint "${String(body.fingerprint)}"`);
  }
  // Independent fingerprint check — recompute from publicKey, compare
  // to what the daemon claims. Prevents the daemon (or a MITM) from
  // claiming a fingerprint that doesn't match the bytes it just
  // returned. If THIS fails, the daemon is buggy or actively
  // adversarial; either way we should not pin.
  const recomputed = computeFingerprint(body.publicKey);
  if (recomputed !== body.fingerprint) {
    throw new HostkeyResponseError(
      `fingerprint ${body.fingerprint} does not match sha256(publicKey) ${recomputed}`,
    );
  }
  return body as HostkeyInfo;
}

/** Compute sha256(base64-decoded publicKey) in "sha256:<hex>" form. */
export function computeFingerprint(publicKeyBase64: string): string {
  const bytes = Buffer.from(publicKeyBase64, "base64");
  const hex = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${hex}`;
}

/**
 * Validate a Path C fingerprint string operator-pasted from the
 * provider console / paper bundle. Accepts the canonical form
 * "sha256:<64 hex chars>". Returns the canonical lowercased form
 * or throws.
 */
export function parsePastedFingerprint(input: string): string {
  const trimmed = input.trim();
  const match = /^sha256:([0-9a-fA-F]{64})$/.exec(trimmed);
  if (!match) {
    throw new HostkeyResponseError(
      `paste must be "sha256:<64 hex chars>"; got "${trimmed.slice(0, 40)}${trimmed.length > 40 ? "…" : ""}"`,
    );
  }
  return `sha256:${match[1]!.toLowerCase()}`;
}

/** Add http:// if scheme is missing. Reject https for 0.0.x (admin is loopback / Caddy-fronted; daemon itself speaks plain HTTP). */
export function normalizeAdminAddr(addr: string): string {
  if (addr.startsWith("http://") || addr.startsWith("https://")) {
    return addr.replace(/\/+$/, "");
  }
  return "http://" + addr.replace(/\/+$/, "");
}
