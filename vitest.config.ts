import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Library / Worker packages — node environment, no app setup.
        test: {
          name: "packages",
          globals: true,
          include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test-d.ts"],
          // The control-plane *-adapter.test.ts files are Bun tests (import
          // bun:test / bun:sqlite) run via `bun test`, not vitest — exclude
          // them so vitest doesn't try to load bun: builtins it can't resolve.
          exclude: [...configDefaults.exclude, "**/src/local/*-adapter.test.ts"],
          typecheck: {
            include: ["packages/*/src/**/*.test-d.ts"],
          },
        },
      },
      // The dashboard app brings its own config (jsdom env, MSW setup, the @
      // alias, React/Tailwind plugins) — run its tests under that config
      // instead of the bare packages one.
      "./apps/dashboard",
    ],
  },
});
