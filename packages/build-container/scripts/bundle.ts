/**
 * Bundle src/server.ts → dist/server.mjs
 * Inlines @solcreek/sdk so the container doesn't need to npm install it.
 */

import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: "dist/server.mjs",
  external: ["node:*"],
  logLevel: "info",
});

console.log("Built dist/server.mjs");
