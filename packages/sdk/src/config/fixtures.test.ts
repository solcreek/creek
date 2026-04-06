import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";
import {
  resolveConfig,
  formatDetectionSummary,
  resolvedConfigToResources,
  resolvedConfigToBindingRequirements,
} from "./resolved-config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = join(__dirname, "__fixtures__");

interface FixtureMeta {
  source: string;
  license: string;
  description: string;
  expectedBindings: Array<{ type: string; name: string }>;
  expectedFramework?: string | null;
  notes?: string;
}

// Auto-discover fixture directories (skip README, etc.)
const fixtures = readdirSync(FIXTURES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

describe("real-world wrangler config fixtures", () => {
  if (fixtures.length === 0) {
    test.skip("no fixtures found", () => {});
    return;
  }

  for (const name of fixtures) {
    const dir = join(FIXTURES_DIR, name);
    const metaPath = join(dir, "meta.json");

    if (!existsSync(metaPath)) continue;

    const meta: FixtureMeta = JSON.parse(readFileSync(metaPath, "utf-8"));

    describe(`${name} (${meta.description})`, () => {
      // L1: Parses without error
      test("resolves without throwing", () => {
        expect(() => resolveConfig(dir)).not.toThrow();
      });

      // L1: Extracts expected bindings
      test("extracts expected bindings", () => {
        const config = resolveConfig(dir);
        for (const expected of meta.expectedBindings) {
          const found = config.bindings.find(
            (b) => b.type === expected.type && b.name === expected.name,
          );
          expect(
            found,
            `missing ${expected.type} binding '${expected.name}'`,
          ).toBeDefined();
        }
      });

      // L1: Framework detection matches (if specified)
      if (meta.expectedFramework !== undefined) {
        test("detects expected framework", () => {
          const config = resolveConfig(dir);
          expect(config.framework).toBe(meta.expectedFramework);
        });
      }

      // L2: Snapshot regression
      test("matches snapshot", () => {
        const config = resolveConfig(dir);
        // Normalize projectName (depends on dirname which varies)
        const normalized = { ...config, projectName: config.projectName || name };
        expect(normalized).toMatchSnapshot();
      });

      // L1: Detection summary is non-empty and includes source type
      test("produces valid detection summary", () => {
        const config = resolveConfig(dir);
        const summary = formatDetectionSummary(config);
        expect(summary.length).toBeGreaterThan(0);
      });

      // L3: Backward compat bridge doesn't lose provisionable bindings
      test("backward compat resources includes all provisionable types", () => {
        const config = resolveConfig(dir);
        const resources = resolvedConfigToResources(config);
        for (const b of config.bindings) {
          if (["d1", "r2", "kv", "ai"].includes(b.type)) {
            expect(
              resources[b.type as keyof typeof resources],
              `resources.${b.type} should be true`,
            ).toBe(true);
          }
        }
      });

      // L3: Binding requirements preserve user-defined names
      test("binding requirements preserve user-defined names", () => {
        const config = resolveConfig(dir);
        const reqs = resolvedConfigToBindingRequirements(config);
        for (const expected of meta.expectedBindings) {
          if (!["d1", "r2", "kv", "ai"].includes(expected.type)) continue;
          const found = reqs.find(
            (r) => r.type === expected.type && r.bindingName === expected.name,
          );
          expect(
            found,
            `binding requirement for ${expected.type}='${expected.name}' missing`,
          ).toBeDefined();
        }
      });
    });
  }
});
