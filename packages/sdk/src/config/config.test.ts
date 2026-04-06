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
    expect(config.resources.d1).toBe(false);
    expect(config.resources.r2).toBe(false);
    expect(config.resources.kv).toBe(false);
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
d1 = true
r2 = true
kv = false
ai = true
`);
    expect(config.project.name).toBe("my-saas");
    expect(config.project.framework).toBe("react-router");
    expect(config.build.command).toBe("pnpm build");
    expect(config.build.output).toBe("build/client");
    expect(config.resources.d1).toBe(true);
    expect(config.resources.r2).toBe(true);
    expect(config.resources.kv).toBe(false);
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
    expect(config.resources).toEqual({ d1: false, r2: false, kv: false, ai: false });
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
