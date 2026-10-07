import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dryRunNextStep,
  hasDeployablePayload,
  deployCommand,
  productionSuccessBreadcrumbs,
} from "./deploy.js";
import { AGENT_PROD_DEPLOY, AGENT_SANDBOX_DEPLOY } from "../utils/output.js";
import { materializeVinextFixture } from "../../../sdk/src/framework/__fixtures__/vinext-cf-output/materialize.js";

vi.mock("../utils/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../utils/config.js")>();
  return { ...orig, getToken: () => null };
});

describe("hasDeployablePayload", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creek-payload-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is false for an empty directory", () => {
    expect(hasDeployablePayload(dir)).toBe(false);
  });

  it("is false for creek.toml alone", () => {
    writeFileSync(join(dir, "creek.toml"), '[project]\nname = "x"\n');
    expect(hasDeployablePayload(dir)).toBe(false);
  });

  it("is true with index.html", () => {
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
    expect(hasDeployablePayload(dir)).toBe(true);
  });

  it("is true with public/index.html", () => {
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public/index.html"), "<h1>hi</h1>");
    expect(hasDeployablePayload(dir)).toBe(true);
  });

  it("is true with package.json", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(hasDeployablePayload(dir)).toBe(true);
  });
});

describe("dryRunNextStep", () => {
  it("points at doctor when there are blocking findings", () => {
    expect(dryRunNextStep({ blockingCount: 1, wouldDeploy: false, targetType: "sandbox" })).toMatch(
      /creek doctor --json/,
    );
    expect(dryRunNextStep({ blockingCount: 2, wouldDeploy: true, targetType: "sandbox" })).toMatch(
      /2 blocking issues/,
    );
  });

  it("tells the agent to add files when nothing is deployable", () => {
    const step = dryRunNextStep({
      blockingCount: 0,
      wouldDeploy: false,
      targetType: "sandbox",
    });
    expect(step).toContain("Nothing deployable yet");
    expect(step).toContain(AGENT_SANDBOX_DEPLOY);
  });

  it("emits a copy-pasteable --sandbox/--prod command, never a bare creek deploy", () => {
    expect(dryRunNextStep({ blockingCount: 0, wouldDeploy: true, targetType: "sandbox" })).toBe(
      AGENT_SANDBOX_DEPLOY,
    );
    expect(dryRunNextStep({ blockingCount: 0, wouldDeploy: true, targetType: "production" })).toBe(
      AGENT_PROD_DEPLOY,
    );
  });
});

describe("productionSuccessBreadcrumbs", () => {
  it("leads with creek verify of the production URL", () => {
    const crumbs = productionSuccessBreadcrumbs("https://app.example.com", "my-app");
    expect(crumbs[0].command).toBe("creek verify https://app.example.com --json");
    expect(crumbs.some((c) => c.command.includes("creek deployments --project my-app"))).toBe(true);
  });
});

describe("creek deploy --dry-run (agent path)", () => {
  let dir: string;
  let prevCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creek-dry-run-"));
    prevCwd = process.cwd();
    process.chdir(dir);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  });

  async function dryRunJson(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await (deployCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
      args: { "dry-run": true, json: true, ...extra },
    });
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    return JSON.parse(out.slice(out.indexOf("{")));
  }

  it("creek.toml alone is not wouldDeploy: true", async () => {
    writeFileSync(
      join(dir, "creek.toml"),
      '[project]\nname = "creek-ax-init"\n\n[build]\ncommand = "npm run build"\noutput = "dist"\n',
    );
    const plan = await dryRunJson();
    expect(plan.wouldDeploy).toBe(false);
    expect(String(plan.nextStep)).not.toMatch(/^npx creek deploy$/);
    expect(String(plan.nextStep)).not.toBe("creek deploy");
    expect(String(plan.nextStep)).toContain("index.html");
    expect(String(plan.nextStep)).toContain("--sandbox");
  });

  it("index.html is wouldDeploy: true and nextStep is --sandbox --json", async () => {
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
    const plan = await dryRunJson();
    expect(plan.wouldDeploy).toBe(true);
    expect(plan.nextStep).toBe(AGENT_SANDBOX_DEPLOY);
    expect(plan.target).toMatchObject({ type: "sandbox" });
  });

  it("explicit directory with only style.css is wouldDeploy: true (matches deployDirectory)", async () => {
    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "style.css"), "body{color:red}");
    const plan = await dryRunJson({ dir: dist });
    expect(plan.wouldDeploy).toBe(true);
    expect(plan.nextStep).toBe(AGENT_SANDBOX_DEPLOY);
  });

  it("cwd with only style.css (no explicit dir) is not wouldDeploy", async () => {
    writeFileSync(join(dir, "style.css"), "body{color:red}");
    const plan = await dryRunJson();
    expect(plan.wouldDeploy).toBe(false);
  });

  it("cwd with creek.toml plus README is not wouldDeploy", async () => {
    writeFileSync(join(dir, "creek.toml"), '[project]\nname = "x"\n');
    writeFileSync(join(dir, "README.md"), "# hi");
    const plan = await dryRunJson();
    expect(plan.wouldDeploy).toBe(false);
  });

  it("explicit dir with only README is wouldDeploy: true", async () => {
    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "README.md"), "# hi");
    const plan = await dryRunJson({ dir: dist });
    expect(plan.wouldDeploy).toBe(true);
  });

  it("empty dir surfaces blocking findings and does not suggest a bare deploy", async () => {
    const plan = await dryRunJson();
    expect(plan.wouldDeploy).toBe(false);
    expect(String(plan.nextStep)).toMatch(/creek doctor --json/);
    expect(String(plan.nextStep)).not.toContain("npx creek deploy");
  });
});

describe("creek deploy --dry-run (vinext)", () => {
  let dir: string;
  let prevCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creek-dry-run-vinext-"));
    prevCwd = process.cwd();
    process.chdir(dir);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "demo",
        dependencies: { vinext: "^1.0.1", "@vinext/cloudflare": "^1.0.1" },
        scripts: { build: "vite build" },
      }),
    );
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  });

  async function dryRunJson(): Promise<Record<string, any>> {
    await (deployCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
      args: { "dry-run": true, json: true, sandbox: true },
    });
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    return JSON.parse(out.slice(out.indexOf("{")));
  }

  it("built: reports the Build Output's bindings and compat", async () => {
    materializeVinextFixture(dir);
    const plan = await dryRunJson();
    expect(plan.wouldDeploy).toBe(true);
    expect(plan.config.framework).toBe("vinext");
    expect(plan.bindings).toEqual([{ name: "VINEXT_KV_CACHE", type: "kv" }]);
    expect(plan.vinext).toMatchObject({
      built: true,
      compatibilityDate: "2026-10-07",
      compatibilityFlags: ["nodejs_compat"],
      unsupportedBindings: [],
    });
  });

  it("not built yet: still deployable, says bindings are known after the build", async () => {
    const plan = await dryRunJson();
    expect(plan.wouldDeploy).toBe(true);
    expect(plan.vinext.built).toBe(false);
    expect(plan.vinext.note).toContain("not built yet");
    expect(plan.findings.map((f: { code: string }) => f.code)).toContain("CK-NOTHING-TO-DEPLOY");
  });

  it("unsupported binding in the last build blocks the deploy", async () => {
    materializeVinextFixture(dir, { workerConfig: "bindings" });
    const plan = await dryRunJson();
    expect(plan.wouldDeploy).toBe(false);
    expect(plan.vinext.unsupportedBindings).toEqual([{ type: "images", name: "IMAGES" }]);
    expect(plan.findings.map((f: { code: string }) => f.code)).toContain(
      "CK-VINEXT-UNSUPPORTED-BINDINGS",
    );
    expect(plan.bindings.map((b: { name: string }) => b.name)).toEqual([
      "VINEXT_KV_CACHE",
      "DB",
      "FILES",
      "AI",
    ]);
  });

  it("legacy wrangler setup blocks the deploy before any build", async () => {
    writeFileSync(
      join(dir, "wrangler.jsonc"),
      '{ "name": "demo", "main": "vinext/server/fetch-handler" }',
    );
    const plan = await dryRunJson();
    expect(plan.wouldDeploy).toBe(false);
    const codes = plan.findings.map((f: { code: string }) => f.code);
    expect(codes).toContain("CK-VINEXT-LEGACY-SETUP");
    expect(codes).not.toContain("CK-WORKER-MISSING");
  });
});
