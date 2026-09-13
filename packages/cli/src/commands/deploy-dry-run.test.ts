import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryRunNextStep, hasDeployablePayload, deployCommand } from "./deploy.js";
import { AGENT_PROD_DEPLOY, AGENT_SANDBOX_DEPLOY } from "../utils/output.js";

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

  async function dryRunJson(
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
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

  it("empty dir surfaces blocking findings and does not suggest a bare deploy", async () => {
    const plan = await dryRunJson();
    expect(plan.wouldDeploy).toBe(false);
    expect(String(plan.nextStep)).toMatch(/creek doctor --json/);
    expect(String(plan.nextStep)).not.toContain("npx creek deploy");
  });
});
