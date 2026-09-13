import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginCommand } from "./login.js";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}

describe("creek login (non-TTY)", () => {
  let stdout: string;
  beforeEach(() => {
    stdout = "";
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as never);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("refuses browser login without --token", async () => {
    try {
      await (loginCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
        args: { json: true },
      });
      throw new Error("expected process.exit");
    } catch (err) {
      if (!(err instanceof ExitSignal)) throw err;
      expect(err.code).toBe(1);
    }
    const payload = JSON.parse(stdout.slice(stdout.indexOf("{")));
    expect(payload).toMatchObject({
      ok: false,
      error: "interactive_login_unsupported",
    });
    expect(payload.breadcrumbs[0].command).toContain("creek login --token");
  });

  it("refuses --headless without --token", async () => {
    try {
      await (loginCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
        args: { json: true, headless: true },
      });
      throw new Error("expected process.exit");
    } catch (err) {
      if (!(err instanceof ExitSignal)) throw err;
      expect(err.code).toBe(1);
    }
    const payload = JSON.parse(stdout.slice(stdout.indexOf("{")));
    expect(payload.error).toBe("interactive_login_unsupported");
  });
});
