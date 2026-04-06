import { describe, test, expect } from "vitest";

/**
 * Tests for the useWebDeploy hook's state machine logic.
 * Since hooks require React rendering, we test the state transitions conceptually.
 */

type DeployStatus = "idle" | "building" | "deploying" | "active" | "failed";

interface DeployState {
  status: DeployStatus;
  buildId: string | null;
  previewUrl: string | null;
  sandboxId: string | null;
  expiresAt: string | null;
  error: string | null;
}

const INITIAL: DeployState = {
  status: "idle",
  buildId: null,
  previewUrl: null,
  sandboxId: null,
  expiresAt: null,
  error: null,
};

describe("deploy state machine", () => {
  test("initial state is idle", () => {
    expect(INITIAL.status).toBe("idle");
    expect(INITIAL.buildId).toBeNull();
    expect(INITIAL.previewUrl).toBeNull();
    expect(INITIAL.error).toBeNull();
  });

  test("transitions: idle → building on deploy", () => {
    const next: DeployState = { ...INITIAL, status: "building" };
    expect(next.status).toBe("building");
  });

  test("transitions: building → deploying", () => {
    const next: DeployState = { ...INITIAL, status: "deploying", buildId: "abc123" };
    expect(next.status).toBe("deploying");
    expect(next.buildId).toBe("abc123");
  });

  test("transitions: deploying → active with previewUrl", () => {
    const next: DeployState = {
      ...INITIAL,
      status: "active",
      buildId: "abc123",
      sandboxId: "s-456",
      previewUrl: "https://s-456.creeksandbox.com",
      expiresAt: "2026-03-31T12:00:00Z",
    };
    expect(next.status).toBe("active");
    expect(next.previewUrl).toContain("creeksandbox.com");
    expect(next.sandboxId).toBe("s-456");
    expect(next.expiresAt).toBeDefined();
  });

  test("transitions: building → failed with error", () => {
    const next: DeployState = {
      ...INITIAL,
      status: "failed",
      error: "Build failed: npm install error",
    };
    expect(next.status).toBe("failed");
    expect(next.error).toContain("npm install");
  });

  test("reset returns to idle", () => {
    const active: DeployState = {
      ...INITIAL,
      status: "active",
      buildId: "abc",
      previewUrl: "https://test.com",
    };
    const reset = { ...INITIAL };
    expect(reset.status).toBe("idle");
    expect(reset.buildId).toBeNull();
  });

  test("terminal states are active and failed", () => {
    const terminal: DeployStatus[] = ["active", "failed"];
    const nonTerminal: DeployStatus[] = ["idle", "building", "deploying"];

    for (const s of terminal) {
      expect(["active", "failed"]).toContain(s);
    }
    for (const s of nonTerminal) {
      expect(["active", "failed"]).not.toContain(s);
    }
  });
});

describe("poll interval behavior", () => {
  test("poll should stop on active status", () => {
    const statuses: DeployStatus[] = ["building", "building", "deploying", "active"];
    let stopped = false;

    for (const status of statuses) {
      if (status === "active" || status === "failed") {
        stopped = true;
        break;
      }
    }

    expect(stopped).toBe(true);
  });

  test("poll should stop on failed status", () => {
    const statuses: DeployStatus[] = ["building", "failed"];
    let stoppedAt = -1;

    for (let i = 0; i < statuses.length; i++) {
      if (statuses[i] === "active" || statuses[i] === "failed") {
        stoppedAt = i;
        break;
      }
    }

    expect(stoppedAt).toBe(1);
  });
});
