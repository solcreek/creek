import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import consola from "consola";

// Where every `creek deploy` invocation goes, over the whole matrix of path ×
// sign-in × target flag. Each row is checked twice: the --dry-run plan's
// target (or refusal), and the deploy function the real run dispatches to.
// The two must agree — that is the point of deployDestination.

const auth = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("../utils/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../utils/config.js")>();
  return { ...orig, getToken: () => auth.token, isSignedIn: () => Boolean(auth.token) };
});
// An interactive terminal, when a test asks for one. Off by default, so the
// matrix runs as the agent/CI (non-TTY) environment it is about.
const tty = vi.hoisted(() => ({ value: false }));
vi.mock("../utils/output.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../utils/output.js")>();
  return {
    ...orig,
    get isTTY() {
      return tty.value;
    },
    resolveJsonMode: (args: { json?: boolean }) => args.json === true || !tty.value,
    shouldAutoConfirm: (args: { yes?: boolean }) => args.yes === true || !tty.value,
  };
});
vi.mock("../utils/tos.js", () => ({
  ensureTosAccepted: vi.fn(async () => ({ version: "test", acceptedAt: "test" })),
}));

import { deployCommand, deployHandlers } from "./deploy.js";

type Scenario =
  | "project-cf"
  | "project-creekd"
  | "creekd-server"
  | "directory"
  | "directory-creekd"
  | "build-output"
  | "template"
  | "from-github"
  | "repo-url"
  | "broken-config";
type Flag = "prod" | "sandbox" | "yes" | "none";
type Outcome =
  | "production"
  | "sandbox"
  | "creekd"
  | "not_authenticated"
  | "prod_unsupported"
  | "sandbox_unsupported"
  | "creekd_dir_unsupported"
  | "invalid_config";

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
  // Server-only creekd project: a worker entry, no package.json or HTML.
  "creekd-server": {
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
  // A broken creek.toml next to a dist/ folder: the parse error, never a
  // build-output guess (prod_unsupported → `creek init`) or a sandbox.
  "broken-config": {
    out: {
      prod: "invalid_config",
      sandbox: "invalid_config",
      yes: "invalid_config",
      none: "invalid_config",
    },
    in: {
      prod: "invalid_config",
      sandbox: "invalid_config",
      yes: "invalid_config",
      none: "invalid_config",
    },
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
    case "creekd-server":
      writeFileSync(
        join(dir, "creek.toml"),
        '[project]\nname = "api"\ntarget = "creekd"\n\n[build]\ncommand = ""\nworker = "server.js"\n',
      );
      writeFileSync(join(dir, "server.js"), "Bun.serve({ fetch: () => new Response('ok') });\n");
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
    case "broken-config":
      writeFileSync(join(dir, "creek.toml"), '[project]\nname = "unterminated\n');
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist/index.html"), "<h1>hi</h1>");
      return {};
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
    tty.value = false;
  });

  async function runDeploy(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    writeSpy.mockClear();
    await (deployCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
      args: { json: true, ...args },
    });
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    return out.includes("{") ? JSON.parse(out.slice(out.indexOf("{"))) : {};
  }

  /**
   * A plan's nextStep must never recommend a deploy the CLI would refuse:
   * re-run the recommended `creek deploy …` as a dry run from the same place
   * and assert it plans the same destination.
   */
  async function expectNextStepNotRefused(
    plan: Record<string, unknown>,
    base: Record<string, unknown>,
  ): Promise<void> {
    const step = typeof plan.nextStep === "string" ? plan.nextStep : "";
    const match = /creek deploy( [^\s]+)*? --json/.exec(step);
    if (!match) return;
    const args: Record<string, unknown> = { ...base, "dry-run": true };
    delete args.dir;
    for (const tok of match[0].split(" ").slice(2)) {
      if (tok === "--json") continue;
      if (tok.startsWith("--")) args[tok.slice(2)] = true;
      else args.dir = tok;
    }
    const again = await runDeploy(args);
    expect(again.error, `nextStep "${match[0]}" is refused`).toBeUndefined();
    expect(again.target).toMatchObject({ type: (plan.target as { type: string }).type });
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
        await expectNextStepNotRefused(plan, base);
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

  // No target flag in an interactive terminal: the real dispatch, including
  // the production confirm (resolveDeployEnv), for every path.
  const SANDBOX_ONLY_HANDLERS = new Set(["deployDirectory", "deployTemplate", "deploySandbox"]);
  const INTERACTIVE_ROWS = (Object.keys(MATRIX) as Scenario[]).flatMap((scenario) =>
    (["out", "in"] as const).map((state) => ({
      scenario,
      state,
      outcome: MATRIX[scenario][state].none,
    })),
  );

  it.each(INTERACTIVE_ROWS)(
    "interactive, no flag: $scenario, signed $state → $outcome",
    async ({ scenario, state, outcome }) => {
      tty.value = true;
      auth.token = state === "in" ? "test-token" : null;
      const prompt = vi.spyOn(consola, "prompt").mockResolvedValue(true as never);
      vi.spyOn(consola, "error").mockImplementation(() => {});
      vi.spyOn(consola, "warn").mockImplementation(() => {});
      vi.spyOn(consola, "info").mockImplementation(() => {});
      const base = setUp(dir, scenario);
      const refused = !["production", "sandbox", "creekd"].includes(outcome);

      exitSpy.mockClear();
      await (deployCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
        args: { ...base },
      });
      const called = Object.entries(handlerSpies)
        .filter(([, spy]) => spy.mock.calls.length > 0)
        .map(([name]) => name);

      if (refused) {
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(called).toEqual([]);
        return;
      }
      const handler = expectedHandler(scenario, outcome);
      expect(called).toEqual([handler]);
      // The production confirm fires exactly when a local project is about to
      // reach production without --prod (repo-url confirms after its clone,
      // inside the spied handler; --from-github has no confirm).
      const confirms = scenario === "project-cf" && outcome === "production";
      expect(prompt).toHaveBeenCalledTimes(confirms ? 1 : 0);
      // A sandbox-only handler must mean a sandbox destination, and nothing
      // reached the production deploy.
      if (SANDBOX_ONLY_HANDLERS.has(handler)) {
        expect(outcome).toBe("sandbox");
        expect(handlerSpies.deployAuthenticated).not.toHaveBeenCalled();
      }
      if (outcome === "production" && scenario === "project-cf") {
        expect(handlerSpies.deploySandbox).not.toHaveBeenCalled();
      }
    },
  );

  it("interactive, no flag: declining the production confirm deploys nothing", async () => {
    tty.value = true;
    auth.token = "test-token";
    const prompt = vi.spyOn(consola, "prompt").mockResolvedValue(false as never);
    vi.spyOn(consola, "info").mockImplementation(() => {});
    setUp(dir, "project-cf");
    await (deployCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
      args: {},
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    for (const spy of Object.values(handlerSpies)) expect(spy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it("interactive, no flag, signed in: a directory upload is a sandbox, not production", async () => {
    tty.value = true;
    auth.token = "test-token";
    const prompt = vi.spyOn(consola, "prompt").mockResolvedValue(true as never);
    vi.spyOn(consola, "info").mockImplementation(() => {});
    setUp(dir, "directory");
    await (deployCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
      args: { dir: "site" },
    });
    expect(handlerSpies.deployDirectory).toHaveBeenCalledTimes(1);
    expect(handlerSpies.deployAuthenticated).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("a server-only creekd project is deployable and points at the creekd deploy", async () => {
    setUp(dir, "creekd-server");
    const plan = await runDeploy({ "dry-run": true });
    expect(plan).toMatchObject({
      target: { type: "creekd" },
      wouldDeploy: true,
      nextStep: "creek deploy --yes --json",
    });
    // Before the entry exists: not deployable (doctor's CK-WORKER-MISSING),
    // and never a --sandbox suggestion.
    rmSync(join(dir, "server.js"));
    const empty = await runDeploy({ "dry-run": true });
    expect(empty.wouldDeploy).toBe(false);
    expect(String(empty.nextStep)).not.toContain("--sandbox");
  });

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

  it("a broken creek.toml reports the parser's diagnostic", async () => {
    setUp(dir, "broken-config");
    const out = await runDeploy({ prod: true });
    expect(out).toMatchObject({ ok: false, error: "invalid_config" });
    expect(String(out.message)).toMatch(/^Couldn't read the project config: /);
    expect(JSON.stringify(out)).not.toContain("creek init");
  });

  // An invalid creekd config must not fail open to a Cloudflare destination
  // (signed-out --prod → not_authenticated, --sandbox → a Creek sandbox).
  it.each([
    { flags: { prod: true }, signedIn: false },
    { flags: { sandbox: true }, signedIn: false },
    { flags: { sandbox: true }, signedIn: true },
    { flags: { yes: true }, signedIn: true },
  ])(
    "an invalid creekd creek.toml is invalid_config ($flags, signed in: $signedIn)",
    async ({ flags, signedIn }) => {
      auth.token = signedIn ? "test-token" : null;
      writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
      // Valid TOML, invalid schema: project names are lowercase.
      writeFileSync(
        join(dir, "creek.toml"),
        '[project]\nname = "Self Hosted"\ntarget = "creekd"\n\n[build]\ncommand = ""\noutput = "."\n',
      );
      for (const dryRun of [true, false]) {
        const out = await runDeploy({ ...flags, ...(dryRun ? { "dry-run": true } : {}) });
        expect(out).toMatchObject({ ok: false, error: "invalid_config" });
      }
      for (const spy of Object.values(handlerSpies)) expect(spy).not.toHaveBeenCalled();
    },
  );

  it("prod_unsupported points at what works instead", async () => {
    auth.token = "test-token";
    setUp(dir, "directory");
    const out = await runDeploy({ dir: "site", prod: true });
    const cmds = (out.breadcrumbs as { command: string }[]).map((b) => b.command);
    expect(cmds).toContain("creek deploy site --sandbox --json");
    expect(cmds).toContain("creek init --json");
  });
});
