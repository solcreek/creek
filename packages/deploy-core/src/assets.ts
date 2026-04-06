import type { DeployEnv, AssetManifestEntry } from "./types.js";
import { cfApi } from "./cf-api.js";

/**
 * Compute a 32-char hex hash for an asset file, salted for tenant isolation.
 * WfP Static Assets deduplicates by hash within a namespace — salting ensures
 * different tenants don't share assets even if file content is identical.
 */
export async function hashAsset(content: ArrayBuffer, salt: string): Promise<string> {
  const saltBytes = new TextEncoder().encode(salt);
  const combined = new Uint8Array(saltBytes.length + content.byteLength);
  combined.set(saltBytes, 0);
  combined.set(new Uint8Array(content), saltBytes.length);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 32);
}

/**
 * Step 1: Create an asset upload session.
 * Returns JWT + bucket groups indicating which files to upload.
 */
export async function createAssetUploadSession(
  env: DeployEnv,
  scriptName: string,
  manifest: Record<string, AssetManifestEntry>,
): Promise<{ jwt: string; buckets: string[][] }> {
  const path = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/dispatch/namespaces/${env.DISPATCH_NAMESPACE}/scripts/${scriptName}/assets-upload-session`;
  return cfApi(env, "POST", path, { manifest });
}

/**
 * Step 2: Upload asset files using the session JWT.
 * Uploads files in bucket groups as specified by the upload session.
 */
export async function uploadAssetFiles(
  env: DeployEnv,
  uploadJwt: string,
  buckets: string[][],
  assets: Record<string, ArrayBuffer>,
  hashToPath: Record<string, string>,
): Promise<string> {
  const path = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/assets/upload?base64=true`;
  let completionJwt = "";

  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const filePath = hashToPath[hash];
      if (!filePath || !assets[filePath]) continue;
      const b64 = arrayBufferToBase64(assets[filePath]);
      form.append(hash, b64);
    }

    const result = (await cfApi(env, "POST", path, form, uploadJwt)) as { jwt?: string };
    completionJwt = result.jwt ?? completionJwt;
  }

  return completionJwt;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
