import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test-d.ts", "apps/*/src/**/*.test.ts"],
    typecheck: {
      include: ["packages/*/src/**/*.test-d.ts"],
    },
  },
});
