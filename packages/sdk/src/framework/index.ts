import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Framework } from "../types/index.js";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function detectFramework(packageJson: PackageJson): Framework | null {
  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  // SSR / meta frameworks (order matters — check specific before generic)
  if (allDeps["next"]) return "nextjs";
  if (allDeps["@tanstack/react-start"]) return "tanstack-start";
  if (allDeps["react-router"]) return "react-router";
  if (allDeps["@sveltejs/kit"]) return "sveltekit";
  if (allDeps["@solidjs/start"]) return "solidstart";
  if (allDeps["nuxt"]) return "nuxt";

  // Astro — its own build tool (not Vite-wrapped from our detection POV),
  // outputs static HTML to dist/ by default. SSR mode also supported via
  // astro adapters but we treat the common SSG case first.
  if (allDeps["astro"]) return "astro";

  // VitePress — Vue-based docs site generator. Check BEFORE vite-vue
  // because vitepress bundles vite + vue transitively; without this
  // check a VitePress project would slip through as vite-vue and ship
  // with the wrong build output directory.
  if (allDeps["vitepress"]) return "vitepress";

  // SPA frameworks (Vite-wrapped)
  if (allDeps["vite"]) {
    if (allDeps["react"] || allDeps["react-dom"]) return "vite-react";
    if (allDeps["vue"]) return "vite-vue";
    if (allDeps["svelte"]) return "vite-svelte";
    if (allDeps["solid-js"]) return "vite-solid";
  }

  return null;
}

export function getDefaultBuildOutput(framework: Framework | null): string {
  switch (framework) {
    case "nextjs":
      return ".open-next";
    case "react-router":
      return "build/client";
    case "sveltekit":
      return ".svelte-kit/output/client";
    case "solidstart":
    case "nuxt":
      return ".output/public";
    case "astro":
    case "tanstack-start":
    case "vite-react":
    case "vite-vue":
    case "vite-svelte":
    case "vite-solid":
      return "dist";
    case "vitepress":
      // Default VitePress outDir when the `.vitepress/config.*` is at
      // the project root. Projects that keep their docs in a
      // subfolder (the common `docs/` pattern) use the deploy button's
      // subpath support so this detection runs against that subfolder
      // as the effective project root.
      return ".vitepress/dist";
    default:
      return "dist";
  }
}

export function getDefaultBuildCommand(framework: Framework | null): string {
  return "npm run build";
}

/**
 * Detect Next.js deploy mode from project context.
 * - "static": output: "export" detected → deploy as static files
 * - "opennext": SSR mode → Creek auto-manages @opennextjs/cloudflare
 * - "unknown": not a Next.js project
 *
 * @param projectDir - optional: check next.config for `output: "export"`
 */
export function detectNextjsMode(
  packageJson: PackageJson,
  projectDir?: string,
): "static" | "opennext" | "unknown" {
  const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  if (!allDeps["next"]) return "unknown";

  // Check if next.config has output: "export"
  if (projectDir) {
    for (const name of ["next.config.ts", "next.config.js", "next.config.mjs"]) {
      const configPath = join(projectDir, name);
      if (existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, "utf-8");
          // Simple heuristic — check for output: "export" in source
          if (/output\s*:\s*["']export["']/.test(content)) return "static";
        } catch {}
      }
    }
  }

  // Default: SSR mode — Creek will auto-install @opennextjs/cloudflare
  return "opennext";
}

/**
 * Detect if the project is in a monorepo.
 * Checks for workspace config files in parent directories.
 */
export function detectMonorepo(projectDir: string): { isMonorepo: boolean; root: string | null } {
  let dir = resolve(projectDir);

  while (dir !== dirname(dir)) {
    dir = dirname(dir);
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return { isMonorepo: true, root: dir };
    if (existsSync(join(dir, "turbo.json"))) return { isMonorepo: true, root: dir };
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (pkg.workspaces) return { isMonorepo: true, root: dir };
    } catch {}
  }

  return { isMonorepo: false, root: null };
}

/** Get the path to the SSR server entry relative to the build output directory */
export function getSSRServerEntry(framework: Framework | null): string | null {
  switch (framework) {
    case "nextjs":
      return "worker.js";
    case "tanstack-start":
      return "server/server.js";
    case "react-router":
      return "../server/index.js";
    case "sveltekit":
      return "../server/index.js";
    case "nuxt":
      return "../server/index.mjs";
    case "solidstart":
      return "../server/index.mjs";
    default:
      return null;
  }
}

/** Get the subdirectory within build output that contains client assets */
export function getClientAssetsDir(framework: Framework | null): string | null {
  switch (framework) {
    case "nextjs":
      return "assets";
    case "tanstack-start":
      return "client";
    case "react-router":
      return null;
    case "sveltekit":
      return null;
    case "nuxt":
      return null;
    case "solidstart":
      return null;
    default:
      return null;
  }
}

// Re-export server file utilities
export {
  getSSRServerDir,
  collectServerFiles,
  isPreBundledFramework,
} from "./server-files.js";
