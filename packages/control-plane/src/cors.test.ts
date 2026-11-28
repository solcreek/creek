import { describe, it, expect } from "vitest";
import { app } from "./index.js";

/**
 * The dashboard (app.creek.dev) calls this API (api.creek.dev) cross-origin.
 * Before any request that isn't GET/HEAD/POST-with-a-simple-body, the browser
 * sends an OPTIONS preflight and refuses to send the real request unless the
 * answer's Access-Control-Allow-Methods names its method.
 *
 * PATCH was missing from that list while three PATCH routes existed, so the
 * dashboard's resource rename and trigger settings were refused by browsers
 * (the CLI and SDK, which do no CORS check, kept working). The first test
 * derives the methods from the app's own routes: a route registered with a
 * method the preflight doesn't allow fails here.
 */

const DASHBOARD = "https://app.creek.dev";

async function preflight(method: string, origin = DASHBOARD, path = "/projects") {
  return app.request(path, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": "content-type",
    },
  });
}

const allowedMethods = (res: Response) =>
  (res.headers.get("Access-Control-Allow-Methods") ?? "").split(",").map((m) => m.trim());

describe("CORS preflight", () => {
  it("allows every method the app has a route for", async () => {
    const used = new Set(app.routes.map((r) => r.method).filter((m) => m !== "ALL"));
    expect(used.size).toBeGreaterThan(1);

    const allowed = allowedMethods(await preflight("GET"));

    expect([...used].filter((m) => !allowed.includes(m))).toEqual([]);
  });

  it.each([
    ["PATCH", "/resources/r1"],
    ["PATCH", "/projects/p/triggers"],
    ["PATCH", "/projects/p/domains"],
    ["PUT", "/projects/p/deployments/d/bundle"],
    ["DELETE", "/projects/p"],
  ])("answers a %s preflight for %s from the dashboard", async (method, path) => {
    const res = await preflight(method, DASHBOARD, path);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(DASHBOARD);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(allowedMethods(res)).toContain(method);
  });

  it("allows the cf-turnstile-response header in preflight responses", async () => {
    const res = await app.request("/api/auth/sign-in/email", {
      method: "OPTIONS",
      headers: {
        Origin: DASHBOARD,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, cf-turnstile-response",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(DASHBOARD);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("cf-turnstile-response");
  });

  it.each(["https://evil.example", "http://app.creek.dev", "https://app.creek.dev.evil.example"])(
    "names no allowed origin for %s",
    async (origin) => {
      const res = await preflight("PATCH", origin);

      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    },
  );
});
