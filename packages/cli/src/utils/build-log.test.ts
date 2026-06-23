import { describe, it, expect } from "vitest";
import { BuildLogEmitter, flushBuildLog } from "./build-log.js";

describe("BuildLogEmitter", () => {
  it("accumulates lines and serializes them as ndjson", () => {
    const log = new BuildLogEmitter();
    log.info("detect", "framework=nextjs");
    log.warn("bundle", "large asset");
    log.error("activate", "boom", "CK-DEPLOY-X");
    expect(log.count).toBe(3);

    const lines = log.toNdjson().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ step: "detect", level: "info", stream: "creek", msg: "framework=nextjs" });
    expect(lines[1]).toMatchObject({ step: "bundle", level: "warn" });
    expect(lines[2]).toMatchObject({ step: "activate", level: "error", code: "CK-DEPLOY-X" });
  });

  it("omits the code field when none is given", () => {
    const log = new BuildLogEmitter();
    log.info("build", "ok");
    expect(JSON.parse(log.toNdjson())).not.toHaveProperty("code");
  });
});

describe("flushBuildLog", () => {
  it("returns 'sent' when the upload resolves before the cap", async () => {
    expect(await flushBuildLog(Promise.resolve({ ok: true }), 1000)).toBe("sent");
  });

  it("returns 'failed' (without throwing) when the upload rejects", async () => {
    expect(await flushBuildLog(Promise.reject(new Error("401")), 1000)).toBe("failed");
  });

  it("returns 'timeout' instead of hanging when the upload stalls", async () => {
    // A promise that never settles — flushBuildLog must give up after capMs
    // rather than block the deploy result forever.
    const start = Date.now();
    const outcome = await flushBuildLog(new Promise(() => {}), 20);
    expect(outcome).toBe("timeout");
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("waits for a slow-but-finishing upload within the cap", async () => {
    const slow = new Promise((r) => setTimeout(() => r("done"), 10));
    expect(await flushBuildLog(slow, 1000)).toBe("sent");
  });
});
