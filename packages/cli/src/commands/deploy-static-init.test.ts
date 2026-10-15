import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "@solcreek/sdk";

// init → sandbox deploy of a plain static site with both index.html and
// public/index.html. init writes output = "public" (the SDK's precedence);
// the sandbox upload must then be public/, as it was before init and as a
// production deploy would upload — not the project root.

vi.mock("../utils/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../utils/config.js")>();
  return { ...orig, getToken: () => null, isSignedIn: () => false };
});
vi.mock("../utils/tos.js", () => ({
  ensureTosAccepted: vi.fn(async () => ({ version: "test", acceptedAt: "test" })),
}));
// Record the uploaded directory; stop at the network call.
vi.mock("../utils/bundle.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../utils/bundle.js")>();
  return { ...orig, collectAssets: vi.fn(orig.collectAssets) };
});
vi.mock("../utils/sandbox.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../utils/sandbox.js")>();
  return {
    ...orig,
    sandboxDeploy: vi.fn(async () => {
      throw new Error("stop: test never reaches the sandbox API");
    }),
  };
});

import { collectAssets } from "../utils/bundle.js";
import { sandboxDeploy } from "../utils/sandbox.js";
import { initCommand } from "./init.js";
import { deployCommand } from "./deploy.js";
import { prepareDeployBundle } from "../utils/prepare-bundle.js";

type Run = (ctx: { args: Record<string, unknown> }) => Promise<unknown>;

describe("init → sandbox deploy of a static site", () => {
  let dir: string;
  let prevCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "creek-static-init-")));
    prevCwd = process.cwd();
    process.chdir(dir);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.mocked(collectAssets).mockClear();
    vi.mocked(sandboxDeploy).mockClear();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
    writeSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("uploads public/ (the init'd output), not the project root", async () => {
    writeFileSync(join(dir, "index.html"), "<h1>root draft</h1>");
    writeFileSync(join(dir, "notes.txt"), "not for publishing");
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public/index.html"), "<h1>site</h1>");

    await (initCommand.run as Run)({ args: { _: [], name: "site", yes: true } });
    expect(resolveConfig(dir).buildOutput).toBe("public");

    await (deployCommand.run as Run)({ args: { sandbox: true, json: true } });

    expect(collectAssets).toHaveBeenCalledTimes(1);
    expect(vi.mocked(collectAssets).mock.calls[0][0]).toBe(join(dir, "public"));
    const uploaded = vi.mocked(sandboxDeploy).mock.calls[0][0] as {
      assets: Record<string, unknown>;
    };
    expect(Object.keys(uploaded.assets).sort()).toEqual(["index.html"]);

    // Production's bundle step collects from the same directory.
    vi.mocked(collectAssets).mockClear();
    await prepareDeployBundle({
      cwd: dir,
      resolved: resolveConfig(dir),
      skipBuild: true,
      jsonMode: true,
    });
    expect(vi.mocked(collectAssets).mock.calls[0][0]).toBe(join(dir, "public"));
  });

  it("without a usable output (old init config), keeps the root-first fallback", async () => {
    writeFileSync(join(dir, "index.html"), "<h1>root</h1>");
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public/index.html"), "<h1>site</h1>");
    writeFileSync(
      join(dir, "creek.toml"),
      '[project]\nname = "site"\n\n[build]\ncommand = "npm run build"\noutput = "dist"\n',
    );

    await (deployCommand.run as Run)({ args: { sandbox: true, json: true } });

    expect(vi.mocked(collectAssets).mock.calls[0][0]).toBe(dir);
  });
});
