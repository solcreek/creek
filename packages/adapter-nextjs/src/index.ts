import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { NextAdapter } from "next";
import { handleBuild } from "./build.js";

/**
 * Detect the monorepo root by walking up looking for workspace markers.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (
      existsSync(path.join(dir, "pnpm-workspace.yaml")) ||
      existsSync(path.join(dir, "turbo.json"))
    ) {
      return dir;
    }
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.workspaces) return dir;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

const adapter: NextAdapter = {
  name: "@solcreek/adapter-nextjs",

  modifyConfig(config, { phase }) {
    if (phase !== "phase-production-build") return config;

    const projectDir = process.cwd();
    const repoRoot = findRepoRoot(projectDir);
    const isMonorepo = repoRoot !== projectDir;

    return {
      ...config,
      // Standalone output produces standard CJS that esbuild can bundle.
      // (CLI forces --webpack since Turbopack doesn't support standalone.)
      output: "standalone" as const,
      // For monorepos: trace deps from the repo root
      ...(isMonorepo && {
        outputFileTracingRoot: repoRoot,
      }),
    };
  },

  async onBuildComplete(ctx) {
    await handleBuild(ctx);
  },
};

export default adapter;
