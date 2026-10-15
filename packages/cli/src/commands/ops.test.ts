import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Human mode: tests run without a TTY, which switches JSON mode on by itself.
vi.mock("../utils/output.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/output.js")>()),
  resolveJsonMode: () => false,
}));

const { opsCommand } = await import("./ops.js");

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.CREEK_API_URL = "https://cp.test";
});
afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  delete process.env.CREEK_API_URL;
});

async function exitCode(): Promise<number> {
  try {
    await opsCommand.run!({ args: { _: [], sub: "health" }, rawArgs: [] } as never);
    return 0;
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}

describe("creek ops health (human mode)", () => {
  it("exits 1 when a service is down, as --json does", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await exitCode()).toBe(1);
  });

  it("exits 0 when every service is up", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) =>
      new Response(null, {
        status: new URL(String(input)).hostname === "cp.test" ? 404 : 400,
      })) as typeof fetch;
    expect(await exitCode()).toBe(0);
  });
});
