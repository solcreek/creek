/**
 * Bundle src/server.ts → dist/server.mjs via rolldown.
 * Inlines @solcreek/sdk (and its deps) so the container doesn't need to npm
 * install them; only Node builtins stay external.
 */

import { build } from "rolldown";

await build({
  input: "src/server.ts",
  platform: "node",
  // Keep Node builtins external (platform: "node" also handles bare builtins);
  // everything else — @solcreek/sdk, ajv, and their deps — is inlined.
  external: [/^node:/],
  output: {
    file: "dist/server.mjs",
    format: "esm",
    // src/server.ts uses dynamic import(); inline those into the single file
    // (matching the previous esbuild single-outfile bundle) rather than
    // code-splitting into a dist/ directory.
    codeSplitting: false,
  },
});

console.log("Built dist/server.mjs");
