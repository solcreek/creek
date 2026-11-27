import { describe, test, expect } from "vitest";
import { CreekConfigSchema, parseConfig } from "./index.js";

describe("parseConfig", () => {
  test('accepts framework = "vinext" (written by creek init)', () => {
    const config = parseConfig(`
[project]
name = "my-app"
framework = "vinext"
`);
    expect(config.project.framework).toBe("vinext");
  });

  test("parses minimal creek.toml", () => {
    const config = parseConfig(`
[project]
name = "my-app"
`);
    expect(config.project.name).toBe("my-app");
    expect(config.build.command).toBe("npm run build");
    expect(config.build.output).toBe("dist");
    expect(config.resources.database).toBe(false);
    expect(config.resources.storage).toBe(false);
    expect(config.resources.cache).toBe(false);
    expect(config.resources.ai).toBe(false);
  });

  test("parses full config with resources", () => {
    const config = parseConfig(`
[project]
name = "my-saas"
framework = "react-router"

[build]
command = "pnpm build"
output = "build/client"

[resources]
database = true
storage = true
cache = false
ai = true
`);
    expect(config.project.name).toBe("my-saas");
    expect(config.project.framework).toBe("react-router");
    expect(config.build.command).toBe("pnpm build");
    expect(config.build.output).toBe("build/client");
    expect(config.resources.database).toBe(true);
    expect(config.resources.storage).toBe(true);
    expect(config.resources.cache).toBe(false);
    expect(config.resources.ai).toBe(true);
  });

  test("rejects invalid project name", () => {
    expect(() =>
      parseConfig(`
[project]
name = "My App"
`),
    ).toThrow();
  });

  test("defaults resources to false when section omitted", () => {
    const config = parseConfig(`
[project]
name = "simple"
`);
    expect(config.resources).toEqual({ database: false, storage: false, cache: false, ai: false });
  });

  test("parses cron triggers", () => {
    const config = parseConfig(`
[project]
name = "cron-app"

[triggers]
cron = ["*/5 * * * *", "0 0 * * *"]
`);
    expect(config.triggers.cron).toEqual(["*/5 * * * *", "0 0 * * *"]);
  });

  test("defaults triggers to empty when omitted", () => {
    const config = parseConfig(`
[project]
name = "no-triggers"
`);
    expect(config.triggers.cron).toEqual([]);
    expect(config.triggers.queue).toBe(false);
  });

  test("parses queue trigger", () => {
    const config = parseConfig(`
[project]
name = "queue-app"

[triggers]
queue = true
`);
    expect(config.triggers.queue).toBe(true);
  });

  test("defaults build section when omitted", () => {
    const config = parseConfig(`
[project]
name = "bare"
`);
    expect(config.build.command).toBe("npm run build");
    expect(config.build.output).toBe("dist");
  });
});

// GHSA-mrhx-c7xc-m3w5: zod records one issue per failing array element and only
// stops early when the array carries a length constraint. Without `.max()`, a
// creek.toml with a huge array of bad values allocates millions of issues.
describe("CreekConfigSchema array bounds", () => {
  const huge = Array.from({ length: 1_000_000 }, () => 1);
  // A union nests each branch's issues under one `invalid_union`; count them all.
  type Issue = { errors?: Issue[][] };
  const countIssues = (issues: Issue[]): number =>
    issues.reduce((n, i) => n + 1 + (i.errors ?? []).reduce((m, b) => m + countIssues(b), 0), 0);

  test.each([
    ["triggers.cron", { triggers: { cron: huge } }],
    ["build.run_worker_first", { build: { run_worker_first: huge } }],
  ])("rejects an oversized %s with a bounded issue count", (_field, extra) => {
    const result = CreekConfigSchema.safeParse({ project: { name: "app" }, ...extra });
    expect(result.success).toBe(false);
    expect(countIssues(result.error!.issues as Issue[])).toBeLessThanOrEqual(4);
  });
});
