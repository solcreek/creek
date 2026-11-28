/** Test-only: an RSA key standing in for a Cloudflare Access team's signing key. */

export const TEAM = "acme-team.cloudflareaccess.com";
export const AUD = "a".repeat(64);
export const KID = "test-kid-1";

export interface TestSigner {
  /** The team's `/cdn-cgi/access/certs` body. */
  certs: { keys: JsonWebKey[] };
  publicKey: CryptoKey;
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function createSigner(kid = KID): Promise<TestSigner> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    certs: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" } as JsonWebKey] },
    publicKey: pair.publicKey,
    async sign(claims, header = {}) {
      const h = b64urlJson({ alg: "RS256", kid, typ: "JWT", ...header });
      const p = b64urlJson(claims);
      const sig = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(`${h}.${p}`),
      );
      return `${h}.${p}.${b64url(sig)}`;
    },
  };
}

/** Claims an Access token for TEAM/AUD carries, valid for an hour from `now`. */
export function validClaims(nowSeconds = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  return {
    aud: [AUD],
    email: "visitor@example.com",
    iss: `https://${TEAM}`,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 3600,
    type: "app",
    sub: "user-1",
  };
}
