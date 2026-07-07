import { defineConfig } from "tsdown";

// One bundle per published subpath (see package.json "exports"): . -> index,
// ./react, ./hono. Extensions forced to .js/.d.ts to match the exports map.
// Runtime dep (d1-schema) and peers (react, hono) are externalized by default —
// peers must never be inlined. JSX comes from tsconfig (jsx: react-jsx).
export default defineConfig({
  entry: ["src/index.ts", "src/react.ts", "src/hono.ts"],
  format: "esm",
  dts: true,
  clean: true,
  outDir: "dist",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
