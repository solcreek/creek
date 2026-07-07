import { openDatabase } from "./database.ts";
import { openCache } from "./cache.ts";
import { openStorage } from "./storage.ts";
import { openAssets } from "./assets.ts";

/**
 * BindingSpec uses semantic kinds aligned with the resource model
 * (database / cache / storage / assets) — never CF-specific names
 * like D1/KV/R2. The `driver` field allows future backend variants
 * (sqlite, postgres, fs, s3, r2, ...) while keeping the API stable.
 */
export type BindingSpec =
  | { type: "database"; path: string; driver?: "sqlite" }
  | { type: "cache"; path: string; driver?: "sqlite" }
  | { type: "storage"; path: string; driver?: "fs" }
  | { type: "assets"; dir: string };

export type BindingsConfig = Record<string, BindingSpec>;

export function createEnv<TEnv extends Record<string, unknown> = Record<string, unknown>>(
  config: BindingsConfig,
): TEnv {
  const cache = new Map<string, unknown>();

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      if (cache.has(prop)) return cache.get(prop);

      const binding = config[prop];
      if (!binding) {
        const available = Object.keys(config).join(", ") || "(none)";
        throw new Error(
          `Unknown binding: env.${prop}. Add it to creek.toml.\n` +
            `Available bindings: ${available}`,
        );
      }

      const resolved = resolveBinding(prop, binding);
      cache.set(prop, resolved);
      return resolved;
    },
  };

  return new Proxy({} as Record<string, unknown>, handler) as TEnv;
}

function resolveBinding(name: string, spec: BindingSpec): unknown {
  switch (spec.type) {
    case "database":
      return openDatabase(spec.path);
    case "cache":
      return openCache(spec.path);
    case "storage":
      return openStorage(spec.path);
    case "assets":
      return openAssets(spec.dir);
    default: {
      const exhaustive: never = spec;
      throw new Error(`Unknown binding type for env.${name}: ${JSON.stringify(exhaustive)}`);
    }
  }
}
