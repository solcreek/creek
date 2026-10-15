import { describe, expect, it } from "vitest";
import worker from "./index";

const get = (headers: Record<string, string>, env: Record<string, unknown>) =>
  worker.fetch(
    new Request("https://sandbox.test/api/deployments/recent", { headers }),
    env as never,
    {} as never,
  );

describe("GET /api/deployments/recent — internal auth", () => {
  it("refuses a request without the secret when no secret is configured", async () => {
    // undefined !== undefined is false: the old check let this through.
    const res = await get({}, {});
    expect(res.status).toBe(401);
  });

  it("refuses a wrong secret of the right length", async () => {
    const res = await get({ "x-internal-secret": "internaX" }, { INTERNAL_SECRET: "internal" });
    expect(res.status).toBe(401);
  });
});
