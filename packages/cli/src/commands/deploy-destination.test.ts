import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Where every `creek deploy` invocation goes, over the whole matrix of path ×
// sign-in × target flag. Each row is checked twice: the --dry-run plan's
// target (or refusal), and the deploy function the real run dispatches to.
// The two must agree — that is the point of deployDestination.

const auth = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("../utils/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../utils/config.js")>();
  return { ...orig, getToken: () => auth.token };
});
vi.mock("../utils/tos.js", () => ({
  ensureTosAccepted: vi.fn(async () => ({ version: "test", acceptedAt: "test" })),
}));

import { deployCommand, deployHandlers } from "./deploy.js";

type Scenario =
  | "project-cf"
  | "project-creekd"
  | "directory"
  | "directory-creekd"
  | "build-output"
  | "template"
  | "from-github"
  | "repo-url";
type Flag = "prod" | "sandbox" | "yes" | "none";
type Outcome =
  | "production"
  | "sandbox"
  | "creekd"
  | "not_authenticated"
  | "prod_unsupported"
  | "sandbox_unsupported"
  | "creekd_dir_unsupported";

// Expected destination, written out per scenario (not computed).
const MATRIX: Record<Scenario, { out: Record<Flag, Outcome>; in: Record<Flag, Outcome> }> = {
  "project-cf": {
    out: { prod: "not_authenticated", sandbox: "sandbox", yes: "sandbox", none: "sandbox" },
    in: { prod: "production", sandbox: "sandbox", yes: "production", none: "production" },
  },
  "project-creekd": {
    out: { prod: "creekd", sandbox: "sandbox_unsupported", yes: "creekd", none: "creekd" },
    in: { prod: "creekd", sandbox: "sandbox_unsupported", yes: "creekd", none: "creekd" },
  },
  directory: {
    out: { prod: "prod_unsupported", sandbox: "sandbox", yes: "sandbox", none: "sandbox" },
    in: { prod: "prod_unsupported", sandbox: "sandbox", yes: "sandbox", none: "sandbox" },
  },
  "directory-creekd": {
    out: {
      prod: "creekd_dir_unsupported",
      sandbox: "creekd_dir_unsupported",
      yes: "creekd_dir_unsupported",
      none: "creekd_dir_unsupported",
    },
    in: {
      prod: "creekd_dir_unsupported",
      sandbox: "creekd_dir_unsupported",
      yes: "creekd_dir_unsupported",
      none: "creekd_dir_unsupported",
    },
  },
  "build-output": {
    out: { prod: "prod_unsupported", sandbox: "sandbox", yes: "sandbox", none: "sandbox" },
    in: { prod: "prod_unsupported", sandbox: "sandbox", yes: "sandbox", none: "sandbox" },
  },
  template: {
    out: { prod: "prod_unsupported", sandbox: "sandbox", yes: "sandbox", none: "sandbox" },
    in: { prod: "prod_unsupported", sandbox: "sandbox", yes: "sandbox", none: "sandbox" },
  },
  "from-github": {
    out: {
      prod: "not_authenticated",
      sandbox: "sandbox_unsupported",
      yes: "not_authenticated",
      none: "not_authenticated",
    },
    in: {
      prod: "production",
      sandbox: "sandbox_unsupported",
      yes: "production",
      none: "production",
    },
  },
  "repo-url": {
    out: { prod: "not_authenticated", sandbox: "sandbox", yes: "sandbox", none: "sandbox" },
    in: { prod: "production", sandbox: "sandbox", yes: "production", none: "production" },
  },
};

/** The deploy function a successful real run must reach. */
function expectedHandler(scenario: Scenario, outcome: Outcome): keyof typeof deployHandlers {
  switch (scenario) {
    case "template":
      return "deployTemplate";
    case "from-github":
      return "deployFromGithub";
    case "repo-url":
      return "deployRepoUrl";
    case "directory":
    case "build-output":
      return "deployDirectory";
    default:
      if (outcome === "creekd") return "deployCreekd";
      return outcome === "production" ? "deployAuthenticated" : "deploySandbox";
  }
}

const CREEKD_TOML =
  '[project]\nname = "self-hosted"\ntarget = "creekd"\n\n[build]\ncommand = ""\noutput = "."\n';

function setUp(dir: string, scenario: Scenario): Record<string, unknown> {
  switch (scenario) {
    case "project-cf":
      writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
      return {};
    case "project-creekd":
      writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
      writeFileSync(join(dir, "creek.toml"), CREEKD_TOML);
      return {};
    case "directory":
      mkdirSync(join(dir, "site"));
      writeFileSync(join(dir, "site/index.html"), "<h1>hi</h1>");
      return { dir: "site" };
    case "directory-creekd":
      mkdirSync(join(dir, "app"));
      writeFileSync(join(dir, "app/index.html"), "<h1>hi</h1>");
      writeFileSync(join(dir, "app/creek.toml"), CREEKD_TOML);
      return { dir: "app" };
    case "build-output":
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist/index.html"), "<h1>hi</h1>");
      return {};
    case "template":
      return { template: "landing" };
    case "from-github":
      return { "from-github": true };
    case "repo-url":
      return { dir: "https://github.com/solcreek/example" };
  }
}

const FLAG_ARGS: Record<Flag, Record<string, unknown>> = {
  prod: { prod: true },
  sandbox: { sandbox: true },
  yes: { yes: true },
  none: {},
};

const ROWS = (Object.keys(MATRIX) as Scenario[]).flatMap((scenario) =>
  (["out", "in"] as const).flatMap((state) =>
    (Object.keys(FLAG_ARGS) as Flag[]).map((flag) => ({
      scenario,
      state,
      flag,
      outcome: MATRIX[scenario][state][flag],
    })),
  ),
);

describe("creek deploy destination matrix", () => {
  let dir: string;
  let prevCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let handlerSpies: Record<string, ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creek-dest-"));
    prevCwd = process.cwd();
    process.chdir(dir);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    handlerSpies = {};
    for (const name of Object.keys(deployHandlers) as (keyof typeof deployHandlers)[]) {
      handlerSpies[name] = vi
        .spyOn(deployHandlers, name)
        .mockImplementation((async () => undefined) as never);
    }
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    auth.token = null;
  });

  async function runDeploy(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    writeSpy.mockClear();
    await (deployCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
      args: { json: true, ...args },
    });
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    return out.includes("{") ? JSON.parse(out.slice(out.indexOf("{"))) : {};
  }

  it.each(ROWS)(
    "$scenario, signed $state, --$flag → $outcome",
    async ({ scenario, state, flag, outcome }) => {
      auth.token = state === "in" ? "test-token" : null;
      const base = setUp(dir, scenario);
      const refused = !["production", "sandbox", "creekd"].includes(outcome);

      // 1. The dry-run plan reports the destination (or the same refusal).
      const plan = await runDeploy({ ...base, ...FLAG_ARGS[flag], "dry-run": true });
      if (refused) {
        expect(plan).toMatchObject({ ok: false, error: outcome });
      } else {
        expect(plan.target).toMatchObject({ type: outcome });
      }
      for (const spy of Object.values(handlerSpies)) expect(spy).not.toHaveBeenCalled();

      // 2. The real run goes to the same place. With no target flag, a
      // non-TTY run stops at the confirmation gate unless already refused.
      exitSpy.mockClear();
      const real = await runDeploy({ ...base, ...FLAG_ARGS[flag] });
      const called = Object.entries(handlerSpies)
        .filter(([, spy]) => spy.mock.calls.length > 0)
        .map(([name]) => name);
      if (refused) {
        expect(real).toMatchObject({ ok: false, error: outcome });
        expect(called).toEqual([]);
      } else if (flag === "none") {
        expect(real).toMatchObject({ ok: false, error: "confirmation_required" });
        expect(called).toEqual([]);
      } else {
        expect(called).toEqual([expectedHandler(scenario, outcome)]);
        if (scenario === "repo-url") {
          const opts = handlerSpies.deployRepoUrl.mock.calls[0][1] as { destination: string };
          expect(opts.destination).toBe(outcome);
        }
      }
      void stderrSpy;
    },
  );

  it("the plan's nextStep follows the destination", async () => {
    auth.token = "test-token";
    setUp(dir, "directory");
    const dirPlan = await runDeploy({ dir: "site", "dry-run": true });
    expect(dirPlan.nextStep).toBe("creek deploy site --sandbox --json");

    rmSync(join(dir, "site"), { recursive: true });
    setUp(dir, "project-creekd");
    const creekdPlan = await runDeploy({ prod: true, "dry-run": true });
    expect(creekdPlan.nextStep).toBe("creek deploy --yes --json");
  });

  it("--sandbox on a creekd project is refused, pointing at an explicit creekd deploy", async () => {
    setUp(dir, "project-creekd");
    const out = await runDeploy({ sandbox: true });
    expect(out).toMatchObject({ ok: false, error: "sandbox_unsupported" });
    expect(String(out.message)).toContain("creekd");
    const cmds = (out.breadcrumbs as { command: string }[]).map((b) => b.command);
    expect(cmds).toContain("creek deploy --yes --json");
    expect(handlerSpies.deployCreekd).not.toHaveBeenCalled();
  });

  it("prod_unsupported points at what works instead", async () => {
    auth.token = "test-token";
    setUp(dir, "directory");
    const out = await runDeploy({ dir: "site", prod: true });
    const cmds = (out.breadcrumbs as { command: string }[]).map((b) => b.command);
    expect(cmds).toContain("creek deploy site --sandbox --json");
    expect(cmds).toContain("creek init --json");
  });
});
