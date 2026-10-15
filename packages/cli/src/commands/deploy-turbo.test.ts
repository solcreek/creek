import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { reportWaitTimeout, tryTurboDeploy } from "./deploy.js";

// A cache-hit (turbo) deploy polls the deployment until it is terminal. That
// poll must honour --wait like the regular path, not a fixed 30s.
describe("tryTurboDeploy --wait budget", () => {
  let dir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creek-turbo-"));
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
    const git = (cmd: string) =>
      execSync(`git -c user.email=t@example.com -c user.name=t ${cmd}`, {
        cwd: dir,
        stdio: "ignore",
      });
    git("init -q");
    git("add -A");
    git("commit -q -m init");
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    exitSpy.mockRestore();
    writeSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function stuckClient() {
    return {
      createDeployment: vi.fn(async () => ({ cacheHit: true, deployment: { id: "dep-1" } })),
      // Never reaches a terminal state, so only the poll budget ends the wait.
      getDeploymentStatus: vi.fn(async () => ({
        deployment: { status: "deploying", errorMessage: null },
        url: null,
        previewUrl: null,
      })),
    } as unknown as Parameters<typeof tryTurboDeploy>[1];
  }

  it("keeps polling past 30s when --wait asks for longer", async () => {
    const run = tryTurboDeploy(dir, stuckClient(), { id: "p1", slug: "app" }, false, true, 90_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(exitSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(35_000);
    await run;
    expect(exitSpy).toHaveBeenCalledWith(1);
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    // Same report as the regular deploy poll: how long the CLI waited, and
    // where to look next.
    expect(payload).toMatchObject({
      ok: false,
      error: "timeout",
      waited: "90s",
      deploymentId: "dep-1",
      project: "app",
    });
    expect(payload.message).toContain("CLI stopped waiting after 90s");
    // The cwd names no project, so the follow-ups carry --project (pasteable).
    // The first one follows this deploy to its result without re-deploying.
    expect(payload.breadcrumbs.map((b: { command: string }) => b.command)).toEqual([
      "creek deployments wait dep-1 --project app --json",
      "creek deployments logs dep-1 --project app --json",
    ]);
  });

  async function turboOutcome(status: string) {
    const client = {
      createDeployment: vi.fn(async () => ({ cacheHit: true, deployment: { id: "dep-3" } })),
      getDeploymentStatus: vi.fn(async () => ({
        deployment: { status, failedStep: null, errorMessage: null },
        url: null,
        previewUrl: null,
      })),
    } as unknown as Parameters<typeof tryTurboDeploy>[1];
    // A real exit never returns; stop the poll loop the way it would.
    exitSpy.mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await tryTurboDeploy(dir, client, { id: "p1", slug: "app" }, false, true);
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    return JSON.parse(out.slice(out.indexOf("{")));
  }

  it("a cancelled cache deploy keeps error deploy_failed; status says it was cancelled", async () => {
    expect(await turboOutcome("cancelled")).toMatchObject({
      ok: false,
      error: "deploy_failed",
      status: "cancelled",
      deploymentId: "dep-3",
    });
  });

  it("suggests no re-deploy it cannot make pasteable, only the project-aware log", async () => {
    const out = await turboOutcome("failed");
    expect(out.breadcrumbs.map((b: { command: string }) => b.command)).toEqual([
      "creek deployments logs dep-3 --project app --json",
    ]);
  });

  it("a failed cache deploy carries deploymentId, failedStep and the classified reason", async () => {
    const client = {
      createDeployment: vi.fn(async () => ({ cacheHit: true, deployment: { id: "dep-2" } })),
      getDeploymentStatus: vi.fn(async () => ({
        deployment: { status: "failed", failedStep: "activate", errorMessage: "boom" },
        url: null,
        previewUrl: null,
        errorCode: "CK-X",
        errorHint: "do y",
      })),
    } as unknown as Parameters<typeof tryTurboDeploy>[1];
    // A real exit never returns; stop the poll loop the way it would.
    exitSpy.mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    // tryTurboDeploy swallows the throw (any error falls back to a full build).
    await tryTurboDeploy(dir, client, { id: "p1", slug: "app" }, false, true);
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload).toMatchObject({
      ok: false,
      error: "deploy_failed",
      deploymentId: "dep-2",
      status: "failed",
      failedStep: "activate",
      errorCode: "CK-X",
      errorHint: "do y",
    });
    expect(payload.breadcrumbs[0].command).toBe(
      "creek deployments logs dep-2 --project app --json",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("reportWaitTimeout formats whole minutes as Nm and the rest as seconds", () => {
    reportWaitTimeout({ jsonMode: true, waitedMs: 120_000, deploymentId: "d" });
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(JSON.parse(out.slice(out.indexOf("{")))).toMatchObject({
      waited: "2m",
      message: "CLI stopped waiting after 2m; the deploy may still be in progress",
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("defaults to the same 2m budget as the regular deploy path", async () => {
    const run = tryTurboDeploy(dir, stuckClient(), { id: "p1", slug: "app" }, false, true);

    await vi.advanceTimersByTimeAsync(100_000);
    expect(exitSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25_000);
    await run;
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
