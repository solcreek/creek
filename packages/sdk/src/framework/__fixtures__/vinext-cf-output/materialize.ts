import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Recreate the captured vinext build output under `projectDir`, at
 * `.cloudflare/output/v0/workers/default/`. Files with captured content
 * (config, `.assetsignore`, `_headers`) are written verbatim; everything
 * else gets a placeholder so the tree's shape matches the real build.
 */
export function materializeVinextFixture(
  projectDir: string,
  options: { workerConfig?: "plain" | "bindings" | "run-worker-first" } = {},
): void {
  const root = join(projectDir, ".cloudflare/output/v0/workers/default");
  const verbatim: Record<string, string> = {
    "worker.config.json": readFileSync(
      join(
        here,
        options.workerConfig && options.workerConfig !== "plain"
          ? `worker.config.${options.workerConfig}.json`
          : "worker.config.json",
      ),
      "utf-8",
    ),
    "assets/.assetsignore": readFileSync(join(here, "assetsignore.txt"), "utf-8"),
    "assets/_headers": readFileSync(join(here, "headers.txt"), "utf-8"),
  };
  const paths = readFileSync(join(here, "files.txt"), "utf-8").split("\n").filter(Boolean);
  for (const rel of paths) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, verbatim[rel] ?? placeholder(rel));
  }
}

function placeholder(rel: string): string {
  if (rel.endsWith(".json")) return "{}";
  if (rel.endsWith(".css")) return "body{}";
  return `export default ${JSON.stringify(rel)};\n`;
}
