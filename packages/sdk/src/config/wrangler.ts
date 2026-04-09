import { parse as parseToml } from "smol-toml";
import { stripJsoncComments } from "./jsonc.js";

// --- Parsed wrangler config (permissive — extra fields ignored) ---

export interface WranglerConfig {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  d1_databases?: Array<{ binding: string; database_name?: string; database_id?: string }>;
  kv_namespaces?: Array<{ binding: string; id?: string; preview_id?: string }>;
  r2_buckets?: Array<{ binding: string; bucket_name?: string; jurisdiction?: string }>;
  ai?: { binding?: string } | boolean;
  durable_objects?: { bindings?: Array<{ name: string; class_name: string }> };
  analytics_engine_datasets?: Array<{ binding: string; dataset?: string }>;
  vars?: Record<string, string>;
  triggers?: { crons?: string[] };
  // Detected but unsupported
  queues?: unknown;
  vectorize?: unknown;
  hyperdrive?: unknown;
}

export type WranglerFormat = "toml" | "json" | "jsonc";

/**
 * Parse a wrangler config file (TOML, JSON, or JSONC) into a typed structure.
 * Permissive: unknown fields are silently ignored, missing fields are undefined.
 */
export function parseWranglerConfig(content: string, format: WranglerFormat): WranglerConfig {
  let raw: Record<string, unknown>;

  if (format === "toml") {
    raw = parseToml(content) as Record<string, unknown>;
  } else {
    const json = format === "jsonc" ? stripJsoncComments(content) : content;
    raw = JSON.parse(json);
  }

  return {
    name: asString(raw.name),
    main: asString(raw.main),
    compatibility_date: asString(raw.compatibility_date),
    compatibility_flags: asStringArray(raw.compatibility_flags),
    d1_databases: asBindingArray(raw.d1_databases, "binding"),
    kv_namespaces: asBindingArray(raw.kv_namespaces, "binding"),
    r2_buckets: asBindingArray(raw.r2_buckets, "binding"),
    ai: raw.ai != null ? raw.ai as WranglerConfig["ai"] : undefined,
    durable_objects: raw.durable_objects as WranglerConfig["durable_objects"],
    analytics_engine_datasets: asBindingArray(raw.analytics_engine_datasets, "binding"),
    vars: raw.vars as Record<string, string> | undefined,
    triggers: raw.triggers as WranglerConfig["triggers"],
    queues: raw.queues,
    vectorize: raw.vectorize,
    hyperdrive: raw.hyperdrive,
  };
}

// --- Helpers ---

function asString(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

function asStringArray(val: unknown): string[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val.filter((v): v is string => typeof v === "string");
}

function asBindingArray<T extends { binding: string }>(
  val: unknown,
  bindingKey: string,
): T[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val.filter(
    (item): item is T =>
      typeof item === "object" && item !== null && typeof (item as Record<string, unknown>)[bindingKey] === "string",
  );
}
