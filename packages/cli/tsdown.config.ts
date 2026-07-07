import { defineConfig } from "tsdown";

// The CLI is an executable with runtime dynamic behavior — it reads its own
// package.json via `import.meta.url`, resolves peer tools (@solcreek/adapter-
// creek, miniflare) with createRequire/require.resolve, and shells out to
// framework builds. Use unbundle mode so every module keeps its own file and
// path (identical layout to the previous tsc build), avoiding any shift in
// import.meta.url / __dirname that bundling would introduce. Runtime deps
// (@solcreek/sdk, esbuild, citty, consola, ajv, smol-toml, ws) stay external.
export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/*.test-d.ts"],
  unbundle: true,
  format: "esm",
  dts: false,
  clean: true,
  outDir: "dist",
  outExtensions: () => ({ js: ".js" }),
  // Externalize EVERY bare specifier (anything not starting with . or /) so no
  // dependency — declared or phantom/transitive (postcss, yaml, …) — is inlined.
  // Matches the old tsc behavior: compile our own src, leave all imports for
  // Node to resolve at runtime.
  external: [/^[^./]/],
});
