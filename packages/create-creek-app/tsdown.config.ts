import { defineConfig } from "tsdown";

// Single bin entry (see package.json "bin"). It's an executable scaffolder, not
// a type-consumed library, so no dts. tsdown preserves the entry's shebang and
// marks the output executable. Deps (citty, consola, giget, ajv) externalized.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: false,
  clean: true,
  outDir: "dist",
  outExtensions: () => ({ js: ".js" }),
});
