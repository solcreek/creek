import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Merge user-supplied data into creek-data.json (and update creek.toml project name).
 * `defaults` is what was already in the template's creek-data.json.
 */
export function applyData(
  dir: string,
  userData: Record<string, unknown>,
  defaults: Record<string, unknown>,
): void {
  const merged = { ...defaults, ...userData };

  // Write merged creek-data.json
  const dataPath = join(dir, "creek-data.json");
  writeFileSync(dataPath, JSON.stringify(merged, null, 2) + "\n");

  // If "name" was provided, also update creek.toml and package.json
  if (typeof merged.name === "string") {
    updateCreekTomlName(dir, merged.name as string);
    updatePackageJsonName(dir, merged.name as string);
  }
}

function updateCreekTomlName(dir: string, name: string): void {
  const tomlPath = join(dir, "creek.toml");
  if (!existsSync(tomlPath)) return;

  let content = readFileSync(tomlPath, "utf-8");
  content = content.replace(/^name\s*=\s*"[^"]*"/m, `name = "${name}"`);
  writeFileSync(tomlPath, content);
}

function updatePackageJsonName(dir: string, name: string): void {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return;

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.name = name;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}
