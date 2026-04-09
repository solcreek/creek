import { describe, test, expect } from "vitest";
import { parseConfig } from "./index.js";

describe("parseConfig", () => {
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
