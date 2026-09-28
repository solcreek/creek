import type { WfPBinding } from "./types.js";

/**
 * `run_worker_first` as Workers Static Assets accepts it: `true` runs the
 * worker before every asset, a list of route patterns (`"/api/*"`, negations
 * with `"!"`) runs it only on those paths.
 */
export type RunWorkerFirst = boolean | string[];

/**
 * Static-assets options for a user-declared worker (render mode `worker`).
 *
 * Such a worker gets an `ASSETS` binding so it can read its own static
 * assets (`env.ASSETS.fetch(request)`), and may ask to run before them
 * (`run_worker_first`). Workers for Platforms honours both for dispatched
 * user workers when they are declared in the upload metadata (verified
 * 2026-09-28, solcreek/creek#56).
 *
 * Framework SSR bundles and the generated SPA worker are left unchanged:
 * some of them switch behaviour when `env.ASSETS` exists.
 */
export function workerAssetsOptions(
  renderMode: "spa" | "ssr" | "worker",
  bindings: WfPBinding[],
  assetsConfig: Record<string, unknown>,
  runWorkerFirst?: RunWorkerFirst | null,
): { bindings: WfPBinding[]; assetsConfig: Record<string, unknown> } {
  if (renderMode !== "worker") return { bindings, assetsConfig };
  const withBinding = bindings.some((b) => b.name === "ASSETS")
    ? bindings
    : [...bindings, { type: "assets", name: "ASSETS" }];
  const config =
    runWorkerFirst === undefined || runWorkerFirst === null || runWorkerFirst === false
      ? assetsConfig
      : { ...assetsConfig, run_worker_first: runWorkerFirst };
  return { bindings: withBinding, assetsConfig: config };
}
