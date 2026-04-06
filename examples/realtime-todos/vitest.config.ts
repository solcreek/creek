import { defineConfig } from "vitest/config";
import path from "node:path";

const runtimeDir = path.resolve(__dirname, "../../packages/runtime");

export default defineConfig({
  resolve: {
    alias: {
      "creek/hono": path.join(runtimeDir, "dist/hono.js"),
      "creek/react": path.join(runtimeDir, "dist/react.js"),
      creek: path.join(runtimeDir, "dist/index.js"),
    },
  },
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
});
