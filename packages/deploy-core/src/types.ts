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
  /**
   * The server file to run as the worker's main module, from the bundle's
   * `manifest.mainModule`. Must be a key of `serverFiles`. When absent, the
   * main module is guessed by file name (see `selectMainModule`).
   */
  mainModule?: string | null;
  renderMode: "spa" | "ssr" | "worker";
  /** `run_worker_first` for a user-declared worker (render mode `worker`). */
  runWorkerFirst?: boolean | string[] | null;
  teamId: string;
  teamSlug: string;
  projectSlug: string;
  plan: string;
  bindings: WfPBinding[];
  /**
   * Override Creek's default Worker compat date. Required when the user's
   * bundle uses Node APIs that only became available on newer dates —
   * e.g. Astro + `@astrojs/cloudflare` pulls in `node:fs` paths that CF's
   * validator rejects unless `compatibility_date >= 2024-09-23`.
   */
  compatibilityDate?: string;
  /** Override compat flags. Defaults to `["nodejs_compat"]`. */
  compatibilityFlags?: string[];
  /**
   * Detected framework. When `"nextjs"`, the deploy injects
   * `nodejs_compat_v2` + the Next.js DO bindings/migrations (ISR/tag
   * cache) so SSR workers validate — parity with the production path.
   */
  framework?: string | null;
}
