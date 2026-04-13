/**
 * Table-driven tests for planDeploy(). Each row is a (name, input,
 * expected) triple covering one combination of framework × workerEntry
 * × buildOutput state. When adding a new scenario, add a row here
 * BEFORE editing planDeploy — the table is the contract.
 *
 * Axes intentionally tested:
 *   1. framework: null | vite-react (SPA) | nuxt (SSR) | astro (special)
 *   2. workerEntry: null | TS source outside output | prebundled in output
 *   3. buildOutput: exists | missing
 *   4. astroCF: null | { serverDir, assetsDir }
 *
 * Combinations that don't appear are either symmetric (e.g. all SPA
 * frameworks behave the same) or genuinely identical to a covered case.
 */

import { describe, test, expect } from "vitest";
import { planDeploy, type PlanDeployInput, type DeployPlan } from "./deploy-plan.js";

function input(overrides: Partial<PlanDeployInput> = {}): PlanDeployInput {
  return {
    framework: null,
    workerEntry: null,
    workerEntryExists: false,
    buildOutput: "dist",
    buildOutputExists: true,
    astroCF: null,
    ...overrides,
  };
}

describe("planDeploy", () => {
  describe("ok cases", () => {
    const cases: Array<[string, Partial<PlanDeployInput>, DeployPlan]> = [
      [
        "pure SPA — vite-react, no worker, dist exists",
        { framework: "vite-react" },
        {
          renderMode: "spa",
          assets: { enabled: true, dir: "dist", excludeFile: null },
          worker: { strategy: "none", entry: null },
        },
      ],
      [
        "pure static — no framework, no worker, dist exists",
        {},
        {
          renderMode: "spa",
          assets: { enabled: true, dir: "dist", excludeFile: null },
          worker: { strategy: "none", entry: null },
        },
      ],
      [
        "vanilla worker — no framework, TS source",
        {
          workerEntry: "worker/index.ts",
          workerEntryExists: true,
          buildOutputExists: false,
        },
        {
          renderMode: "worker",
          assets: { enabled: false, dir: null, excludeFile: null },
          worker: { strategy: "esbuild-bundle", entry: "worker/index.ts" },
        },
      ],
      [
        "vanilla worker — no framework, prebundled in dist (Checkpoint shape)",
        {
          workerEntry: "dist/_worker.mjs",
          workerEntryExists: true,
        },
        {
          renderMode: "worker",
          assets: {
            enabled: true,
            dir: "dist",
            excludeFile: "_worker.mjs",
          },
          worker: { strategy: "upload-asis", entry: "dist/_worker.mjs" },
        },
      ],
      [
        "coexist — vite-react + worker TS source outside dist",
        {
          framework: "vite-react",
          workerEntry: "server/worker.ts",
          workerEntryExists: true,
        },
        {
          renderMode: "worker",
          assets: { enabled: true, dir: "dist", excludeFile: null },
          worker: { strategy: "esbuild-bundle", entry: "server/worker.ts" },
        },
      ],
      [
        "coexist — vite-react + prebundled worker in dist (vite-react-drizzle shape)",
        {
          framework: "vite-react",
          workerEntry: "dist/_worker.mjs",
          workerEntryExists: true,
        },
        {
          renderMode: "worker",
          assets: {
            enabled: true,
            dir: "dist",
            excludeFile: "_worker.mjs",
          },
          worker: { strategy: "upload-asis", entry: "dist/_worker.mjs" },
        },
      ],
      [
        "SSR framework — nuxt, no worker",
        {
          framework: "nuxt",
        },
        {
          renderMode: "ssr",
          assets: { enabled: true, dir: "dist", excludeFile: null },
          worker: { strategy: "ssr-framework", entry: null },
        },
      ],
      [
        "Astro CF adapter — split client/server output",
        {
          framework: "astro",
          astroCF: { serverDir: "dist/server", assetsDir: "dist/client" },
        },
        {
          renderMode: "ssr",
          assets: {
            enabled: true,
            dir: "dist/client",
            excludeFile: null,
          },
          worker: { strategy: "ssr-framework", entry: "dist/server" },
        },
      ],
      [
        "buildOutput path normalization — './dist' treated as 'dist'",
        {
          workerEntry: "./dist/_worker.mjs",
          workerEntryExists: true,
          buildOutput: "./dist",
        },
        {
          renderMode: "worker",
          assets: {
            enabled: true,
            dir: "./dist",
            excludeFile: "_worker.mjs",
          },
          worker: { strategy: "upload-asis", entry: "./dist/_worker.mjs" },
        },
      ],
      [
        "nested prebundled worker — dist/edge/_worker.mjs",
        {
          framework: "vite-react",
          workerEntry: "dist/edge/_worker.mjs",
          workerEntryExists: true,
        },
        {
          renderMode: "worker",
          assets: {
            enabled: true,
            dir: "dist",
            excludeFile: "edge/_worker.mjs",
          },
          worker: { strategy: "upload-asis", entry: "dist/edge/_worker.mjs" },
        },
      ],
    ];

    for (const [name, partialInput, expected] of cases) {
      test(name, () => {
        const result = planDeploy(input(partialInput));
        expect(result).toEqual({ ok: true, plan: expected });
      });
    }
  });

  describe("error cases", () => {
    const errors: Array<[string, Partial<PlanDeployInput>, RegExp]> = [
      [
        "worker entry declared but missing on disk",
        {
          workerEntry: "server/worker.ts",
          workerEntryExists: false,
        },
        /worker entry not found/,
      ],
      [
        "Astro CF adapter + custom worker — ambiguous",
        {
          framework: "astro",
          workerEntry: "server/worker.ts",
          workerEntryExists: true,
          astroCF: { serverDir: "dist/server", assetsDir: "dist/client" },
        },
        /astro CF adapter conflicts/,
      ],
      [
        "SSR framework + custom worker — ambiguous",
        {
          framework: "nuxt",
          workerEntry: "server/worker.ts",
          workerEntryExists: true,
        },
        /already provides server bundle/,
      ],
      [
        "nothing to deploy — no framework, no worker, no build output",
        {
          buildOutputExists: false,
        },
        /nothing to deploy/,
      ],
    ];

    for (const [name, partialInput, expectedReason] of errors) {
      test(name, () => {
        const result = planDeploy(input(partialInput));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toMatch(expectedReason);
        }
      });
    }
  });

  describe("worker source vs prebundled discrimination", () => {
    test(".ts → esbuild-bundle even when path looks like it's in dist", () => {
      // Pathological: user has dist/build.ts. Still TS, still source.
      const result = planDeploy(
        input({
          workerEntry: "dist/build.ts",
          workerEntryExists: true,
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.plan.worker.strategy).toBe("esbuild-bundle");
      }
    });

    test(".mjs outside buildOutput → esbuild-bundle (treat as source)", () => {
      // Edge case: prebundled .mjs file lives outside dist/. Could be
      // user's hand-written ESM module — we don't risk uploading it
      // unwrapped, fall back to esbuild which is safe either way.
      const result = planDeploy(
        input({
          workerEntry: "src/worker.mjs",
          workerEntryExists: true,
          buildOutputExists: false,
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.plan.worker.strategy).toBe("esbuild-bundle");
      }
    });

    test(".cjs in buildOutput → upload-asis", () => {
      const result = planDeploy(
        input({
          workerEntry: "dist/_worker.cjs",
          workerEntryExists: true,
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.plan.worker.strategy).toBe("upload-asis");
      }
    });
  });
});
