/**
 * Compare a presented secret with the configured one without leaking, through
 * timing, how much of it matched. False when either side is missing or empty,
 * so an unset secret never authorizes anyone.
 *
 * Uses the Workers runtime's crypto.subtle.timingSafeEqual; elsewhere (tests
 * on Node) a constant-time XOR loop. Only the length can leak, which is the
 * same for every guess of the right length.
 *
 * Copies: sandbox-api, remote-builder, realtime-worker, control-plane
 * (src/secret-equal.ts in each). Keep them identical.
 */
export function secretEqual(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!presented || !expected) return false;
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
