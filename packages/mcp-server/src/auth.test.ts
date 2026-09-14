import { describe, expect, it } from "vitest";
import { missingKeyResult, resolveApiKey } from "./auth.js";

describe("resolveApiKey", () => {
  it("reads Authorization Bearer", () => {
    const h = new Headers({ authorization: "Bearer ck_live_abc" });
    expect(resolveApiKey(h)).toBe("ck_live_abc");
  });

  it("reads x-api-key", () => {
    const h = new Headers({ "x-api-key": "ck_live_xyz" });
    expect(resolveApiKey(h)).toBe("ck_live_xyz");
  });

  it("prefers Bearer over x-api-key", () => {
    const h = new Headers({
      authorization: "Bearer from-auth",
      "x-api-key": "from-x",
    });
    expect(resolveApiKey(h)).toBe("from-auth");
  });

  it("returns null when neither header is set", () => {
    expect(resolveApiKey(new Headers())).toBeNull();
  });
});

describe("missingKeyResult", () => {
  it("is a structured MCP error telling the agent not to pass apiKey", () => {
    const r = missingKeyResult();
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload).toMatchObject({ ok: false, error: "not_authenticated" });
    expect(payload.message).toMatch(/Do not pass apiKey/i);
  });
});
