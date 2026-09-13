import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyCommand } from "./verify.js";

describe("creek verify", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it("rejects a non-http URL with invalid_url JSON", async () => {
    await (verifyCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<unknown>)({
      args: { url: "file:///tmp/x", json: true },
    });
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    const payload = JSON.parse(out.slice(out.indexOf("{")));
    expect(payload).toMatchObject({ ok: false, error: "invalid_url" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
