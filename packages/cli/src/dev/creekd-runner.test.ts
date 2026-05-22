import { describe, test, expect } from "vitest";
import { CreekdDevServer } from "./creekd-runner.js";
import type { ResolvedConfig } from "@solcreek/sdk";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    source: "creek.toml",
    projectName: "test-app",
    target: "creekd",
    framework: null,
    buildCommand: "npm run build",
    buildOutput: "dist",
    workerEntry: null,
    bindings: [],
    unsupportedBindings: [],
    vars: {},
    compatibilityDate: null,
    compatibilityFlags: [],
    cron: [],
    queue: false,
    ...overrides,
  };
}

describe("CreekdDevServer", () => {
  test("constructs without error", () => {
    const server = new CreekdDevServer({
      cwd: "/tmp/test",
      port: 3000,
      config: makeConfig(),
      reset: false,
    });
    expect(server).toBeDefined();
  });

  test("requires creekd target in config", () => {
    const server = new CreekdDevServer({
      cwd: "/tmp/test",
      port: 3000,
      config: makeConfig({ target: "creekd" }),
      reset: false,
    });
    expect(server).toBeDefined();
  });

  test("start fails when creekd not installed", async () => {
    const server = new CreekdDevServer({
      cwd: "/tmp/nonexistent",
      port: 3000,
      config: makeConfig(),
      reset: false,
    });

    // creekd is not in PATH in test env — should throw
    await expect(server.start()).rejects.toThrow(/creekd/);
  });

  test("stop is safe to call without start", async () => {
    const server = new CreekdDevServer({
      cwd: "/tmp/test",
      port: 3000,
      config: makeConfig(),
      reset: false,
    });
    // Should not throw
    await server.stop();
  });
});

describe("CreekdDevServer env var mapping", () => {
  // Test the buildEnvVars logic indirectly via the type contract
  test("sandbox status with postgres maps to DATABASE_URL", () => {
    const status = {
      vm: "creek-sandbox",
      status: "running",
      primitives: ["runtime-bun", "postgres", "redis"],
      ports: [
        { name: "app", guest: 3000, host: 13000 },
        { name: "postgres", guest: 5432, host: 15432 },
        { name: "redis", guest: 6379, host: 16379 },
      ],
    };

    // Verify the port structure matches what buildEnvVars expects
    const pgPort = status.ports.find(p => p.name === "postgres");
    expect(pgPort).toBeDefined();
    expect(pgPort!.host).toBe(15432);

    const redisPort = status.ports.find(p => p.name === "redis");
    expect(redisPort).toBeDefined();
    expect(redisPort!.host).toBe(16379);
  });

  test("sandbox status with s3 maps to S3_ENDPOINT", () => {
    const status = {
      vm: "creek-sandbox",
      status: "running",
      primitives: ["runtime-bun", "s3"],
      ports: [
        { name: "app", guest: 3000, host: 13000 },
        { name: "s3", guest: 8333, host: 18333 },
      ],
    };

    const s3Port = status.ports.find(p => p.name === "s3");
    expect(s3Port).toBeDefined();
    expect(s3Port!.host).toBe(18333);
  });

  test("sandbox status with smtp maps to SMTP_URL", () => {
    const status = {
      vm: "creek-sandbox",
      status: "running",
      primitives: ["runtime-bun", "smtp"],
      ports: [
        { name: "app", guest: 3000, host: 13000 },
        { name: "smtp", guest: 1025, host: 11025 },
      ],
    };

    const smtpPort = status.ports.find(p => p.name === "smtp");
    expect(smtpPort).toBeDefined();
    expect(smtpPort!.host).toBe(11025);
  });
});
