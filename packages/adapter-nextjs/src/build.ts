/**
 * Core build handler for Creek's Next.js adapter.
 *
 * Called by Next.js after build completes via onBuildComplete().
 * With --webpack, .next/server/ contains standard CJS that esbuild
 * can bundle directly (unlike Turbopack's custom chunked format).
 *
 * Note: onBuildComplete runs BEFORE standalone output is generated
 * (Next.js source: build/index.js:2544-2581), so we cannot rely on
 * .next/standalone/. Instead we import directly from .next/server/.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NextAdapter } from "next";
import { generateWorkerEntry } from "./worker-entry.js";
import { bundleForWorkers } from "./bundler.js";
import { writeManifest } from "./manifest.js";

type BuildContext = Parameters<NonNullable<NextAdapter["onBuildComplete"]>>[0];

const OUTPUT_DIR = ".creek/adapter-output";

export async function handleBuild(ctx: BuildContext): Promise<void> {
  const outputDir = path.join(ctx.projectDir, OUTPUT_DIR);
  const assetsDir = path.join(outputDir, "assets");
  const serverDir = path.join(outputDir, "server");

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.mkdir(serverDir, { recursive: true });

  console.log(`\n  [Creek Adapter] Preparing deployment output...`);

  // Step 1: Collect static files
  const assetCount = await collectStaticFiles(ctx.outputs, assetsDir);
  console.log(`  [Creek Adapter] ${assetCount} static files collected`);

  // Step 2: Collect WASM files from all outputs
  const wasmFiles = new Map<string, string>();
  for (const outputs of [ctx.outputs.appPages, ctx.outputs.appRoutes, ctx.outputs.pages, ctx.outputs.pagesApi]) {
    for (const output of outputs) {
      if (output.wasmAssets) {
        for (const [name, absPath] of Object.entries(output.wasmAssets)) {
          wasmFiles.set(name, absPath);
        }
      }
    }
  }

  // Step 3: Collect manifests from .next/ for embedding in the worker.
  // Next.js route modules call loadManifest() which uses fs.readFileSync().
  // CF Workers doesn't have fs, so we embed all manifests and shim the loader.
  const manifests = await collectManifests(ctx.distDir);
  console.log(`  [Creek Adapter] ${Object.keys(manifests).length} manifests embedded`);

  // Step 4: Generate worker entry
  const workerSource = generateWorkerEntry({
    buildId: ctx.buildId,
    routing: ctx.routing,
    outputs: ctx.outputs,
    basePath: ctx.config.basePath || "",
    manifests,
  });

  // Step 4: Bundle with esbuild
  const serverFiles = await bundleForWorkers({
    workerSource,
    outputDir: serverDir,
    serverAssets: new Map(),
    wasmFiles,
    distDir: ctx.distDir,
    repoRoot: ctx.repoRoot,
    standaloneDir: ctx.distDir,
  });

  const totalSize = await getTotalSize(serverDir, serverFiles);
  console.log(`  [Creek Adapter] Worker bundled: ${serverFiles.length} files (${formatSize(totalSize)})`);

  // Step 5: Write deploy manifest
  await writeManifest(outputDir, {
    buildId: ctx.buildId,
    nextVersion: ctx.nextVersion,
    entrypoint: "worker.js",
    serverFiles,
    hasMiddleware: !!ctx.outputs.middleware,
    hasPrerender: ctx.outputs.prerenders.length > 0,
  });

  console.log(`  [Creek Adapter] Output ready: ${OUTPUT_DIR}/`);
}

async function collectStaticFiles(
  outputs: BuildContext["outputs"],
  assetsDir: string,
): Promise<number> {
  let count = 0;
  const allPathnames = new Set(outputs.staticFiles.map((f) => f.pathname));

  for (const file of outputs.staticFiles) {
    let destRelative = file.pathname;
    if (!path.extname(destRelative)) {
      const isDirectoryPrefix = [...allPathnames].some(
        (p) => p !== destRelative && p.startsWith(destRelative + "/"),
      );
      if (isDirectoryPrefix) {
        destRelative = destRelative + "/index.html";
      }
    }
    const destPath = path.join(assetsDir, destRelative);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    try {
      await fs.copyFile(file.filePath, destPath);
      count++;
    } catch {}
  }

  for (const prerender of outputs.prerenders) {
    if (prerender.fallback?.filePath) {
      let destRelative = prerender.pathname;
      if (!path.extname(destRelative)) {
        destRelative = destRelative + "/index.html";
      }
      const destPath = path.join(assetsDir, destRelative);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      try {
        await fs.copyFile(prerender.fallback.filePath, destPath);
        count++;
      } catch {}
    }
  }

  return count;
}

async function getTotalSize(dir: string, files: string[]): Promise<number> {
  let total = 0;
  for (const f of files) {
    try {
      const stat = await fs.stat(path.join(dir, f));
      total += stat.size;
    } catch {}
  }
  return total;
}

/**
 * Collect all JSON manifests from .next/ for embedding in the worker.
 * Returns a map of absolute path → file content string.
 */
async function collectManifests(distDir: string): Promise<Record<string, string>> {
  const manifests: Record<string, string> = {};

  // Recursively find all .json files in .next/ and .next/server/
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip large directories that don't contain manifests
        if (entry.name === "static" || entry.name === "cache" || entry.name === "chunks") continue;
        await walk(fullPath);
      } else if (
        entry.name.endsWith(".json") ||
        entry.name.endsWith(".js") ||
        entry.name === "BUILD_ID" ||
        entry.name === "package.json"
      ) {
        // Manifest-like files: JSON, JS build manifests, BUILD_ID, package.json
        try {
          const stat = await fs.stat(fullPath);
          // Skip files > 1MB (not manifests)
          if (stat.size < 1_000_000) {
            manifests[fullPath] = await fs.readFile(fullPath, "utf-8");
          }
        } catch {}
      }
    }
  }

  await walk(distDir);
  // Also collect the required-server-files manifest
  const reqServerFiles = path.join(distDir, "required-server-files.json");
  try {
    manifests[reqServerFiles] = await fs.readFile(reqServerFiles, "utf-8");
  } catch {}

  return manifests;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
