// Semantic host-runtime API: database / cache / storage / assets.
// Never D1/KV/R2 — those are CF brand terms; we map to them only in
// the cf-adapter at deploy time.

export { openDatabase, CreekDatabase } from './database.ts';
export type { DatabaseResult } from './database.ts';

export { openCache } from './cache.ts';
export type {
  CreekCache,
  CacheGetType,
  CachePutOptions,
  CacheListOptions,
  CacheListEntry,
  CacheListResult,
} from './cache.ts';

export { openStorage } from './storage.ts';
export type {
  CreekStorage,
  StoragePutOptions,
  StorageListOptions,
  StorageObject,
  StorageObjectBody,
  StorageObjects,
} from './storage.ts';

export { openAssets } from './assets.ts';

export { createEnv } from './env.ts';
export type { BindingsConfig, BindingSpec } from './env.ts';

export { run } from './server.ts';
export type {
  ExecutionContextLike,
  WorkerModule,
  RunOptions,
  RunHandle,
} from './server.ts';
