import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

// Mock giget to avoid network calls
vi.mock("giget", () => ({
  downloadTemplate: vi.fn(async (_source: string, opts: { dir: string }) => {
    return { dir: opts.dir };
  }),
}));

import { scaffold } from "../src/scaffold.js";
import { downloadTemplate } from "giget";

const mockedDownload = vi.mocked(downloadTemplate);

describe("scaffold", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "creek-scaffold-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setupMockTemplate(dir: string, opts?: { withSchema?: boolean }) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "creek-data.json"), JSON.stringify({ name: "my-app", title: "Default" }));
    writeFileSync(join(dir, "creek.toml"), '[project]\nname = "my-app"\n');
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-app" }));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n");

    if (opts?.withSchema) {
      writeFileSync(
        join(dir, "creek-template.json"),
        JSON.stringify({
          name: "landing",
          description: "Landing page",
          capabilities: [],
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              theme: { type: "string", enum: ["light", "dark"] },
            },
          },
        }),
      );
    }
  }

  it("preserves .gitignore from template", async () => {
    const dest = join(baseDir, "my-project");
    mockedDownload.mockImplementation(async (_src, opts) => {
      setupMockTemplate(opts!.dir!);
      return { dir: opts!.dir! } as any;
    });

    await scaffold({
      template: "blank",
      dir: dest,
      install: false,
      git: false,
      silent: true,
    });

    expect(existsSync(join(dest, ".gitignore"))).toBe(true);
  });

  it("removes creek-template.json from output", async () => {
    const dest = join(baseDir, "my-project");
    mockedDownload.mockImplementation(async (_src, opts) => {
      setupMockTemplate(opts!.dir!, { withSchema: true });
      return { dir: opts!.dir! } as any;
    });

    await scaffold({
      template: "landing",
      dir: dest,
      install: false,
      git: false,
      silent: true,
    });

    expect(existsSync(join(dest, "creek-template.json"))).toBe(false);
  });

  it("applies user data to creek-data.json", async () => {
    const dest = join(baseDir, "my-project");
    mockedDownload.mockImplementation(async (_src, opts) => {
      setupMockTemplate(opts!.dir!);
      return { dir: opts!.dir! } as any;
    });

    await scaffold({
      template: "blank",
      dir: dest,
      data: { title: "Custom" },
      install: false,
      git: false,
      silent: true,
    });

    const data = JSON.parse(readFileSync(join(dest, "creek-data.json"), "utf-8"));
    expect(data.title).toBe("Custom");
    expect(data.name).toBe("my-project");
  });

  it("updates creek.toml with project name from dir", async () => {
    const dest = join(baseDir, "awesome-app");
    mockedDownload.mockImplementation(async (_src, opts) => {
      setupMockTemplate(opts!.dir!);
      return { dir: opts!.dir! } as any;
    });

    await scaffold({
      template: "blank",
      dir: dest,
      install: false,
      git: false,
      silent: true,
    });

    const toml = readFileSync(join(dest, "creek.toml"), "utf-8");
    expect(toml).toContain('name = "awesome-app"');
  });

  it("resolves built-in template to monorepo examples/", async () => {
    const dest = join(baseDir, "test");
    mockedDownload.mockImplementation(async (_src, opts) => {
      setupMockTemplate(opts!.dir!);
      return { dir: opts!.dir! } as any;
    });

    await scaffold({
      template: "vite-react-drizzle",
      dir: dest,
      install: false,
      git: false,
      silent: true,
    });

    // Built-in templates are subpaths of the monorepo's examples/
    // directory. This keeps "official template" == "tested example"
    // as a single source of truth.
    expect(mockedDownload).toHaveBeenCalledWith(
      "github:solcreek/creek/examples/vite-react-drizzle",
      expect.objectContaining({ dir: dest }),
    );
  });

  it("passes third-party template source directly", async () => {
    const dest = join(baseDir, "test");
    mockedDownload.mockImplementation(async (_src, opts) => {
      setupMockTemplate(opts!.dir!);
      return { dir: opts!.dir! } as any;
    });

    await scaffold({
      template: "github:user/my-template",
      dir: dest,
      install: false,
      git: false,
      silent: true,
    });

    expect(mockedDownload).toHaveBeenCalledWith(
      "github:user/my-template",
      expect.objectContaining({ dir: dest }),
    );
  });

  it("throws on schema validation failure", async () => {
    const dest = join(baseDir, "test");
    mockedDownload.mockImplementation(async (_src, opts) => {
      setupMockTemplate(opts!.dir!, { withSchema: true });
      return { dir: opts!.dir! } as any;
    });

    await expect(
      scaffold({
        template: "landing",
        dir: dest,
        data: { theme: "invalid" },
        install: false,
        git: false,
        silent: true,
      }),
    ).rejects.toThrow("Template data validation failed");
  });

  it("returns result with dir, template, name", async () => {
    const dest = join(baseDir, "cool-app");
    mockedDownload.mockImplementation(async (_src, opts) => {
      setupMockTemplate(opts!.dir!);
      return { dir: opts!.dir! } as any;
    });

    const result = await scaffold({
      template: "blog",
      dir: dest,
      install: false,
      git: false,
      silent: true,
    });

    expect(result.template).toBe("blog");
    expect(result.name).toBe("cool-app");
    expect(result.dir).toBe(dest);
  });
});
