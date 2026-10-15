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
    expect(payload.breadcrumbs.map((b: { command: string }) => b.command)).toEqual([
      "creek status --project app",
      "creek deployments logs dep-1 --project app",
    ]);
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
