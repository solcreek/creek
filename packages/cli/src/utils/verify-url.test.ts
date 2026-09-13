import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { isHttpUrl, verifyUrl } from "./verify-url.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("isHttpUrl", () => {
  it("accepts http and https", () => {
    expect(isHttpUrl("https://9edbc43c.creeksandbox.com")).toBe(true);
    expect(isHttpUrl("http://localhost:8787/")).toBe(true);
  });
  it("rejects non-http and garbage", () => {
    expect(isHttpUrl("ftp://x")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});

describe("verifyUrl", () => {
  it("reports 200, title, sandbox id, and contains hits", async () => {
    server.use(
      http.get("https://sb.test/", () =>
        HttpResponse.html(
          "<html><head><title>AX sim</title></head><body><h1>agent-deployed</h1></body></html>",
          {
            headers: { "x-sandbox-id": "9edbc43c" },
          },
        ),
      ),
    );
    const result = await verifyUrl("https://sb.test/", { contains: ["agent-deployed", "AX sim"] });
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      title: "AX sim",
      sandboxId: "9edbc43c",
    });
    expect(result.contains).toEqual([
      { needle: "agent-deployed", found: true },
      { needle: "AX sim", found: true },
    ]);
    expect(result.ttfbMs).toBeGreaterThanOrEqual(0);
  });

  it("ok is false when a contains needle is missing", async () => {
    server.use(http.get("https://sb.test/missing", () => HttpResponse.html("<h1>hello</h1>")));
    const result = await verifyUrl("https://sb.test/missing", { contains: ["agent-deployed"] });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.error).toContain("agent-deployed");
    expect(result.contains[0]).toEqual({ needle: "agent-deployed", found: false });
  });

  it("ok is false on HTTP 404", async () => {
    server.use(http.get("https://sb.test/gone", () => new HttpResponse("nope", { status: 404 })));
    const result = await verifyUrl("https://sb.test/gone");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toBe("HTTP 404");
  });

  it("does not throw on network failure", async () => {
    server.use(http.get("https://sb.test/down", () => HttpResponse.error()));
    const result = await verifyUrl("https://sb.test/down");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("rejects a non-http URL without fetching", async () => {
    const result = await verifyUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/http or https/i);
  });
});
