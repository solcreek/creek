import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { provePreview } from "./proof.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("provePreview", () => {
  it("reports 200 and title", async () => {
    server.use(
      http.get("https://sb.test/", () =>
        HttpResponse.html("<html><head><title>MCP demo</title></head><body>ok</body></html>"),
      ),
    );
    const proof = await provePreview("https://sb.test/");
    expect(proof).toMatchObject({ ok: true, status: 200, title: "MCP demo" });
  });

  it("ok is false on HTTP 404", async () => {
    server.use(http.get("https://sb.test/gone", () => new HttpResponse("nope", { status: 404 })));
    const proof = await provePreview("https://sb.test/gone");
    expect(proof.ok).toBe(false);
    expect(proof.status).toBe(404);
    expect(proof.error).toBe("HTTP 404");
  });

  it("rejects an oversize Content-Length without reading the body", async () => {
    server.use(
      http.get(
        "https://sb.test/huge-cl",
        () =>
          new HttpResponse("ignored", {
            status: 200,
            headers: {
              "content-type": "text/html",
              "content-length": String(3 * 1024 * 1024),
            },
          }),
      ),
    );
    const proof = await provePreview("https://sb.test/huge-cl");
    expect(proof.ok).toBe(false);
    expect(proof.status).toBe(200);
    expect(proof.error).toMatch(/too large/i);
    expect(proof.title).toBeNull();
  });

  it("rejects a streamed body that exceeds maxBodyBytes without Content-Length", async () => {
    const encoder = new TextEncoder();
    server.use(
      http.get("https://sb.test/huge-stream", () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("x".repeat(100)));
            controller.close();
          },
        });
        return new HttpResponse(stream, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }),
    );
    const proof = await provePreview("https://sb.test/huge-stream", { maxBodyBytes: 64 });
    expect(proof.ok).toBe(false);
    expect(proof.status).toBe(200);
    expect(proof.error).toMatch(/too large/i);
    expect(proof.title).toBeNull();
  });
});
