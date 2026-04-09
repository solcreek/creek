import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveConfig,
  formatDetectionSummary,
  resolvedConfigToResources,
  resolvedConfigToBindingRequirements,
  ConfigNotFoundError,
} from "./resolved-config.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "creek-resolve-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// --- Detection chain priority ---

describe("resolveConfig detection chain", () => {
  test("creek.toml wins over wrangler.toml", () => {
    writeFileSync(
      join(cwd, "creek.toml"),
      `[project]\nname = "from-creek"\n`,
    );
    writeFileSync(
      join(cwd, "wrangler.toml"),
      `name = "from-wrangler"\nmain = "src/index.ts"\n`,
    );

    const config = resolveConfig(cwd);
    expect(config.source).toBe("creek.toml");
    expect(config.projectName).toBe("from-creek");
  });

  test("wrangler.jsonc wins over wrangler.json", () => {
    writeFileSync(
      join(cwd, "wrangler.jsonc"),
      `{ "name": "from-jsonc", "main": "src/index.ts" }`,
    );
    writeFileSync(
      join(cwd, "wrangler.json"),
      `{ "name": "from-json", "main": "src/index.ts" }`,
    );

    const config = resolveConfig(cwd);
    expect(config.source).toBe("wrangler.jsonc");
    expect(config.projectName).toBe("from-jsonc");
  });

  test("wrangler.json wins over wrangler.toml", () => {
    writeFileSync(
      join(cwd, "wrangler.json"),
      `{ "name": "from-json", "main": "src/index.ts" }`,
    );
    writeFileSync(
      join(cwd, "wrangler.toml"),
      `name = "from-toml"\nmain = "src/index.ts"\n`,
    );

    const config = resolveConfig(cwd);
    expect(config.source).toBe("wrangler.json");
  });

  test("wrangler wins over package.json", () => {
    writeFileSync(
      join(cwd, "wrangler.toml"),
      `name = "my-worker"\nmain = "src/index.ts"\n`,
    );
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
    );

    const config = resolveConfig(cwd);
    expect(config.source).toBe("wrangler.toml");
  });

  test("package.json framework wins over index.html", () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { vite: "5.0.0", react: "18.0.0" } }),
    );
    writeFileSync(join(cwd, "index.html"), "<h1>hi</h1>");

    const config = resolveConfig(cwd);
    expect(config.source).toBe("package.json");
    expect(config.framework).toBe("vite-react");
  });

  test("index.html is the last fallback", () => {
    writeFileSync(join(cwd, "index.html"), "<h1>static</h1>");

    const config = resolveConfig(cwd);
    expect(config.source).toBe("index.html");
    expect(config.framework).toBeNull();
    expect(config.buildOutput).toBe(".");
  });

  test("public/index.html fallback", () => {
    mkdirSync(join(cwd, "public"));
    writeFileSync(join(cwd, "public/index.html"), "<h1>static</h1>");

    const config = resolveConfig(cwd);
    expect(config.source).toBe("index.html");
    expect(config.buildOutput).toBe("public");
  });

  test("throws ConfigNotFoundError when nothing found", () => {
    expect(() => resolveConfig(cwd)).toThrow(ConfigNotFoundError);
  });

  test("package.json without framework falls through to index.html", () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { express: "4.0.0" } }),
    );
    writeFileSync(join(cwd, "index.html"), "<h1>hi</h1>");

    const config = resolveConfig(cwd);
    expect(config.source).toBe("index.html");
  });
});

// --- creek.toml conversion ---

describe("fromCreekConfig", () => {
  test("converts resources booleans to bindings with canonical names", () => {
    writeFileSync(
      join(cwd, "creek.toml"),
      `[project]\nname = "my-app"\n\n[resources]\ndatabase = true\nstorage = true\ncache = false\nai = true\n`,
    );

    const config = resolveConfig(cwd);
    expect(config.bindings).toEqual([
      { type: "d1", name: "DB" },
      { type: "r2", name: "STORAGE" },
      { type: "ai", name: "AI" },
    ]);
  });

  test("no resources = no bindings", () => {
    writeFileSync(join(cwd, "creek.toml"), `[project]\nname = "bare"\n`);

    const config = resolveConfig(cwd);
    expect(config.bindings).toEqual([]);
  });
});

// --- wrangler conversion ---

describe("fromWranglerConfig", () => {
  test("extracts bindings with user-defined names", () => {
    writeFileSync(
      join(cwd, "wrangler.toml"),
      `
name = "my-api"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "MY_DB"
database_name = "prod"
database_id = "xxx"

[[kv_namespaces]]
binding = "CACHE"
id = "yyy"
`,
    );

    const config = resolveConfig(cwd);
    expect(config.source).toBe("wrangler.toml");
    expect(config.projectName).toBe("my-api");
    expect(config.workerEntry).toBe("src/index.ts");
    expect(config.compatibilityDate).toBe("2025-01-01");
    expect(config.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(config.bindings).toEqual([
      { type: "d1", name: "MY_DB" },
      { type: "kv", name: "CACHE" },
    ]);
  });

  test("detects framework from package.json alongside wrangler", () => {
    writeFileSync(
      join(cwd, "wrangler.toml"),
      `name = "app"\nmain = "src/index.ts"\n`,
    );
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { hono: "4.0.0", vite: "5.0.0", react: "18.0.0" } }),
    );

    const config = resolveConfig(cwd);
    expect(config.source).toBe("wrangler.toml");
    expect(config.framework).toBe("vite-react");
  });

  test("marks durable objects as unsupported, detects queue", () => {
    writeFileSync(
      join(cwd, "wrangler.toml"),
      `
name = "app"
main = "src/index.ts"

[durable_objects]
bindings = [{ name = "COUNTER", class_name = "CounterDO" }]

[[queues.producers]]
queue = "my-queue"
binding = "QUEUE"
`,
    );

    const config = resolveConfig(cwd);
    expect(config.bindings.find((b) => b.type === "durable_object")).toBeDefined();
    expect(config.queue).toBe(true);
  });

  test("extracts vars", () => {
    writeFileSync(
      join(cwd, "wrangler.toml"),
      `
name = "app"
main = "src/index.ts"

[vars]
API_URL = "https://api.example.com"
`,
    );

    const config = resolveConfig(cwd);
    expect(config.vars).toEqual({ API_URL: "https://api.example.com" });
  });

  test("parses wrangler.jsonc", () => {
    writeFileSync(
      join(cwd, "wrangler.jsonc"),
      `{
  // my config
  "name": "jsonc-app",
  "main": "src/index.ts",
  "d1_databases": [
    { "binding": "DB", "database_id": "xxx", }
  ],
}`,
    );

    const config = resolveConfig(cwd);
    expect(config.source).toBe("wrangler.jsonc");
    expect(config.projectName).toBe("jsonc-app");
    expect(config.bindings).toEqual([{ type: "d1", name: "DB" }]);
  });
});

// --- formatDetectionSummary ---

describe("formatDetectionSummary", () => {
  test("wrangler with bindings", () => {
    writeFileSync(
      join(cwd, "wrangler.toml"),
      `name = "app"\nmain = "src/index.ts"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_id = "x"\n\n[[kv_namespaces]]\nbinding = "KV"\nid = "y"\n`,
    );
    const config = resolveConfig(cwd);
    expect(formatDetectionSummary(config)).toBe("wrangler.toml (D1 + KV)");
  });

  test("package.json with framework", () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
    );
    const config = resolveConfig(cwd);
    expect(formatDetectionSummary(config)).toBe("package.json (Next.js)");
  });

  test("creek.toml with framework + resources", () => {
    writeFileSync(
      join(cwd, "creek.toml"),
      `[project]\nname = "app"\nframework = "react-router"\n\n[resources]\ndatabase = true\n`,
    );
    const config = resolveConfig(cwd);
    expect(formatDetectionSummary(config)).toBe("creek.toml (React Router + D1)");
  });

  test("static site", () => {
    writeFileSync(join(cwd, "index.html"), "<h1>hi</h1>");
    const config = resolveConfig(cwd);
    expect(formatDetectionSummary(config)).toBe("index.html (static site)");
  });
});

// --- Backward compat bridges ---

describe("resolvedConfigToResources", () => {
  test("converts bindings to boolean flags", () => {
    writeFileSync(
      join(cwd, "wrangler.toml"),
      `name = "app"\nmain = "src/index.ts"\n\n[[d1_databases]]\nbinding = "MY_DB"\ndatabase_id = "x"\n`,
    );
    const config = resolveConfig(cwd);
    const resources = resolvedConfigToResources(config);
    expect(resources).toEqual({ d1: true, r2: false, kv: false, ai: false });
  });

  test("empty bindings = all false", () => {
    writeFileSync(join(cwd, "index.html"), "<h1>hi</h1>");
    const config = resolveConfig(cwd);
    const resources = resolvedConfigToResources(config);
    expect(resources).toEqual({ d1: false, r2: false, kv: false, ai: false });
  });
});

describe("resolvedConfigToBindingRequirements", () => {
  test("maps bindings to requirements with user names", () => {
    writeFileSync(
      join(cwd, "wrangler.toml"),
      `name = "app"\nmain = "src/index.ts"\n\n[[d1_databases]]\nbinding = "MY_DB"\ndatabase_id = "x"\n\n[[r2_buckets]]\nbinding = "UPLOADS"\nbucket_name = "b"\n`,
    );
    const config = resolveConfig(cwd);
    const reqs = resolvedConfigToBindingRequirements(config);
    expect(reqs).toEqual([
      { type: "d1", bindingName: "MY_DB" },
      { type: "r2", bindingName: "UPLOADS" },
    ]);
  });

  test("filters out non-provisionable types", () => {
    writeFileSync(
      join(cwd, "wrangler.toml"),
      `name = "app"\nmain = "src/index.ts"\n\n[durable_objects]\nbindings = [{ name = "DO", class_name = "MyDO" }]\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_id = "x"\n`,
    );
    const config = resolveConfig(cwd);
    const reqs = resolvedConfigToBindingRequirements(config);
    // Only D1, not durable_object
    expect(reqs).toEqual([{ type: "d1", bindingName: "DB" }]);
  });
});
