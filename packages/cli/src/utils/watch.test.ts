import { describe, it, expect, vi } from "vitest";
import { watchDeploy, classifyConditions, type WatchOptions } from "./watch.js";
import type { AppEnvelope, CreekdClient } from "./creekd-client.js";

/** Helper: synthesise an AppEnvelope with the named conditions. */
function envelope(
  conds: Array<{ type: string; status: string; reason?: string }>,
): AppEnvelope {
  return {
    apiVersion: "creek.dev/v1alpha1",
    kind: "App",
    metadata: { name: "x", uid: "u", generation: 1, resourceVersion: "1", creationTimestamp: "t" },
    spec: {},
    status: {
      observedGeneration: 1,
      conditions: conds.map((c) => ({
        type: c.type,
        status: c.status,
        lastTransitionTime: "t",
        reason: c.reason ?? "",
      })),
      currentPid: 0, currentPort: 0, restartCount: 0, healthFailures: 0, uptimeMs: 0,
    },
  };
}

/** Mock CreekdClient that returns envelopes from a queue. */
function clientFromQueue(envs: AppEnvelope[]): CreekdClient {
  const queue = [...envs];
  return {
    getApp: vi.fn(async () => {
      const e = queue.shift();
      if (!e) throw new Error("queue exhausted");
      return e;
    }),
  } as unknown as CreekdClient;
}

/** Inject a deterministic clock + no-op sleep for fast tests. */
function fastOpts(extra: Partial<WatchOptions> = {}): WatchOptions {
  let t = 0;
  return {
    now: () => (t += 50), // 50ms advances per call
    sleep: async () => { /* no-op */ },
    pollIntervalMs: 100, // honoured-but-ignored under fake sleep
    timeoutMs: 60_000,
    ...extra,
  };
}

describe("classifyConditions", () => {
  it("Ready=True + Progressing=False → ready", () => {
    expect(classifyConditions(envelope([
      { type: "Ready", status: "True" },
      { type: "Progressing", status: "False" },
    ]))).toBe("ready");
  });

  it("Degraded=True reason=DeployTimeout → deploy_stuck", () => {
    expect(classifyConditions(envelope([
      { type: "Degraded", status: "True", reason: "DeployTimeout" },
      { type: "Ready", status: "False" },
    ]))).toBe("deploy_stuck");
  });

  it("Degraded=True reason=DeployTimeout WINS over Ready=True (race window)", () => {
    // In the (rare) race where conditions show both Ready=True
    // AND a stale Degraded=DeployTimeout, the watcher must report
    // failure rather than calling the deploy successful. The
    // daemon already gave up on this generation; surfacing
    // success would let a stuck deploy be reported as healthy.
    expect(classifyConditions(envelope([
      { type: "Ready", status: "True" },
      { type: "Progressing", status: "False" },
      { type: "Degraded", status: "True", reason: "DeployTimeout" },
    ]))).toBe("deploy_stuck");
  });

  it("Degraded=True with OTHER reason is NOT deploy_stuck", () => {
    // Crashed / CrashLooping / Unhealthy don't mean the daemon
    // timed out. The watcher should keep polling — the supervisor
    // may recover, or the user will see "still progressing"
    // until the wall-clock timeout.
    expect(classifyConditions(envelope([
      { type: "Degraded", status: "True", reason: "CrashLooping" },
      { type: "Progressing", status: "True" },
    ]))).toBe("progressing");
  });

  it("Progressing=True → progressing (keep polling)", () => {
    expect(classifyConditions(envelope([
      { type: "Progressing", status: "True", reason: "DeployInFlight" },
      { type: "Ready", status: "False" },
    ]))).toBe("progressing");
  });

  it("no relevant conditions → unknown (defensive default)", () => {
    expect(classifyConditions(envelope([]))).toBe("unknown");
  });

  it("Ready=True alone (no Progressing condition) → unknown — server hasn't classified", () => {
    // Defensive: a partial response missing Progressing should
    // NOT be treated as ready. Real daemon always emits all four
    // conditions, but a buggy proxy might filter them.
    expect(classifyConditions(envelope([
      { type: "Ready", status: "True" },
    ]))).toBe("unknown");
  });
});

describe("watchDeploy", () => {
  it("returns ready on first poll when already converged", async () => {
    const client = clientFromQueue([
      envelope([{ type: "Ready", status: "True" }, { type: "Progressing", status: "False" }]),
    ]);
    const result = await watchDeploy(client, "x", fastOpts());
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ready");
  });

  it("loops through Progressing → ready", async () => {
    const client = clientFromQueue([
      envelope([{ type: "Progressing", status: "True", reason: "DeployInFlight" }]),
      envelope([{ type: "Progressing", status: "True", reason: "DeployInFlight" }]),
      envelope([{ type: "Ready", status: "True" }, { type: "Progressing", status: "False" }]),
    ]);
    const result = await watchDeploy(client, "x", fastOpts());
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ready");
  });

  it("returns deploy_stuck when Degraded reason=DeployTimeout appears", async () => {
    const client = clientFromQueue([
      envelope([{ type: "Progressing", status: "True", reason: "DeployInFlight" }]),
      envelope([
        { type: "Degraded", status: "True", reason: "DeployTimeout" },
        { type: "Progressing", status: "False", reason: "DeployTimeout" },
      ]),
    ]);
    const result = await watchDeploy(client, "x", fastOpts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("deploy_stuck");
  });

  it("returns watch_timeout when client budget runs out", async () => {
    // now() advances 50ms per call; budget 100ms → after the
    // second elapsed-check we're past budget. Queue must be long
    // enough that the watch doesn't exhaust it first.
    const stillProgressing = envelope([
      { type: "Progressing", status: "True", reason: "DeployInFlight" },
    ]);
    const client = clientFromQueue([stillProgressing, stillProgressing, stillProgressing, stillProgressing]);
    let t = 0;
    const result = await watchDeploy(client, "x", {
      now: () => (t += 60),
      sleep: async () => { /* noop */ },
      timeoutMs: 100,
      pollIntervalMs: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("watch_timeout");
  });

  it("returns fetch_failed when getApp throws", async () => {
    const client = {
      getApp: vi.fn(async () => { throw new Error("ECONNREFUSED"); }),
    } as unknown as CreekdClient;
    const result = await watchDeploy(client, "x", fastOpts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("fetch_failed");
    if (result.reason !== "fetch_failed") throw new Error("unreachable");
    expect(result.error.message).toBe("ECONNREFUSED");
  });

  it("clamps pollIntervalMs at MIN_POLL_MS (100) to prevent busy-loop", async () => {
    let sleepArg: number | undefined;
    const client = clientFromQueue([
      envelope([{ type: "Progressing", status: "True", reason: "..." }]),
      envelope([{ type: "Ready", status: "True" }, { type: "Progressing", status: "False" }]),
    ]);
    await watchDeploy(client, "x", {
      now: () => 0,
      sleep: async (ms) => { sleepArg = ms; },
      pollIntervalMs: 1, // request 1ms
      timeoutMs: 10_000,
    });
    expect(sleepArg).toBe(100); // clamped up to MIN_POLL_MS
  });

  it("invokes onPoll for every observation including the terminal one", async () => {
    const client = clientFromQueue([
      envelope([{ type: "Progressing", status: "True", reason: "..." }]),
      envelope([{ type: "Ready", status: "True" }, { type: "Progressing", status: "False" }]),
    ]);
    const seen: string[] = [];
    await watchDeploy(client, "x", {
      ...fastOpts(),
      onPoll: (env) => {
        const conds = env.status?.conditions ?? [];
        seen.push(conds.map((c) => `${c.type}=${c.status}`).join(" "));
      },
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("Progressing=True");
    expect(seen[1]).toContain("Ready=True");
  });
});
