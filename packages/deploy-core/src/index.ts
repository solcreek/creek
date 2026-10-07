export type { DeployEnv, WfPBinding, AssetManifestEntry, DeployAssetsInput } from "./types.js";
export { cfApi } from "./cf-api.js";
export { hashAsset, createAssetUploadSession, uploadAssetFiles } from "./assets.js";
export { extractAssetMetafiles, ASSET_METAFILES } from "./asset-metafiles.js";
export type { AssetMetafiles } from "./asset-metafiles.js";
export {
  shortDeployId,
  sanitizeBranch,
  deployScriptWithAssets,
  buildSpaWorker,
  deployWithAssets,
} from "./deploy.js";
export { SPA_WORKER_SCRIPT } from "./spa-worker.js";
export {
  selectMainModule,
  mainModuleProblem,
  MainModuleError,
  GUESSED_MAIN_MODULES,
} from "./main-module.js";
export {
  createD1Database,
  getD1DatabaseByName,
  deleteD1Database,
  execD1Query,
  createR2Bucket,
  r2BucketExists,
  deleteR2Bucket,
  createKVNamespace,
  getKVNamespaceByTitle,
  deleteKVNamespace,
} from "./resources.js";

export { workerAssetsOptions, type RunWorkerFirst } from "./worker-assets.js";
