import { defineConfig } from "tsdown";

// One bundle per published subpath export (see package.json "exports"). tsdown
// preserves the src-relative structure, so src/config/index.ts -> dist/config/
// index.js, matching the exports map. Runtime deps (smol-toml, zod) are
// externalized by default (not inlined).
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/types/index.ts",
    "src/config/index.ts",
    "src/framework/index.ts",
    "src/client/index.ts",
  ],
  format: "esm",
  dts: true,
  clean: true,
  outDir: "dist",
  // Keep .js/.d.ts (not tsdown's default .mjs/.d.mts) so the published
  // "exports" map — dist/<subpath>/index.js + index.d.ts — stays valid.
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
