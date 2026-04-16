import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveConfig,
  ConfigNotFoundError,
  type DoctorContext,
  type ResolvedConfig,
} from "@solcreek/sdk";

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export function buildDoctorContext(cwd: string): DoctorContext {
  const fileExists = (relPath: string): boolean =>
    existsSync(join(cwd, relPath));
  const creekTomlPath = join(cwd, "creek.toml");
  const creekTomlRaw = existsSync(creekTomlPath) ? safeRead(creekTomlPath) : null;
  const pkgPath = join(cwd, "package.json");
  const packageJson: PackageJson | null = existsSync(pkgPath)
    ? safeParseJson<PackageJson>(pkgPath)
    : null;
  const resolved: ResolvedConfig | null = resolveConfigSafely(cwd);
  const allDeps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
  return { cwd, resolved, packageJson, creekTomlRaw, fileExists, allDeps };
}

function resolveConfigSafely(cwd: string): ResolvedConfig | null {
  try {
    return resolveConfig(cwd);
  } catch (err) {
    if (err instanceof ConfigNotFoundError) return null;
    return null;
  }
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function safeParseJson<T>(path: string): T | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
