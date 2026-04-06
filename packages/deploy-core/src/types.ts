/**
 * Minimal environment interface for WfP deploy operations.
 * Both control-plane and sandbox-api satisfy this interface.
 */
export interface DeployEnv {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  DISPATCH_NAMESPACE: string;
}

export interface WfPBinding {
  type: string;
  name: string;
  [key: string]: unknown;
}

export interface AssetManifestEntry {
  hash: string;
  size: number;
}

export interface DeployAssetsInput {
  clientAssets: Record<string, ArrayBuffer>;
  serverFiles?: Record<string, ArrayBuffer>;
  renderMode: "spa" | "ssr";
  teamId: string;
  teamSlug: string;
  projectSlug: string;
  plan: string;
  bindings: WfPBinding[];
}
