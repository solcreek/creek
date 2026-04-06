/**
 * AES-256-GCM encryption for environment variable values.
 * Uses Web Crypto API (available in Workers runtime).
 */

const ALGO = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96-bit IV for GCM

async function deriveKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode("creek-env-vars"),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: ALGO, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a plaintext value. Returns a base64 string containing IV + ciphertext.
 */
export async function encrypt(plaintext: string, encryptionKey: string): Promise<string> {
  const key = await deriveKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    encoded,
  );

  // Prepend IV to ciphertext, then base64 encode
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a value produced by encrypt(). Expects base64 string with IV + ciphertext.
 */
export async function decrypt(encrypted: string, encryptionKey: string): Promise<string> {
  const key = await deriveKey(encryptionKey);
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGO, iv },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Mask a value for display: show first 4 chars, replace rest with asterisks.
 */
export function mask(value: string): string {
  if (value.length <= 4) return "****";
  return value.slice(0, 4) + "****";
}
