import { describe, test, expect } from "vitest";
import { generateWorkerWrapper } from "./worker-bundle.js";

describe("generateWorkerWrapper", () => {
  test("generates wrapper with correct relative import", () => {
    const wrapper = generateWorkerWrapper(
      "/project/worker/index.ts",
      "/project/.creek",
    );
    expect(wrapper).toContain('import userModule from "../worker/index"');
  });

  test("strips .ts extension from import path", () => {
    const wrapper = generateWorkerWrapper(
      "/project/src/server.ts",
      "/project/.creek",
    );
    expect(wrapper).toContain('from "../src/server"');
    expect(wrapper).not.toContain(".ts");
  });

  test("strips .tsx extension from import path", () => {
    const wrapper = generateWorkerWrapper(
      "/project/src/app.tsx",
      "/project/.creek",
    );
    expect(wrapper).toContain('from "../src/app"');
    expect(wrapper).not.toContain(".tsx");
  });

  test("imports _runRequest from creek", () => {
    const wrapper = generateWorkerWrapper(
      "/project/worker/index.ts",
      "/project/.creek",
    );
    expect(wrapper).toContain('import { _runRequest, generateWsToken } from "creek"');
  });

  test("wraps handler in _runRequest(env, ctx, ...)", () => {
    const wrapper = generateWorkerWrapper(
      "/project/worker/index.ts",
      "/project/.creek",
    );
    expect(wrapper).toContain("_runRequest(env, ctx,");
    // _runRequest should wrap the handler call
    const runPos = wrapper.indexOf("_runRequest(env, ctx,");
    const handlerPos = wrapper.indexOf("handler.fetch");
    expect(runPos).toBeLessThan(handlerPos);
  });

  test("supports Hono app (handler.fetch)", () => {
    const wrapper = generateWorkerWrapper(
      "/project/worker/index.ts",
      "/project/.creek",
    );
    expect(wrapper).toContain("handler.fetch(request, env, ctx)");
  });

  test("supports plain fetch function", () => {
    const wrapper = generateWorkerWrapper(
      "/project/worker/index.ts",
      "/project/.creek",
    );
    expect(wrapper).toContain("handler(request, env, ctx)");
  });

  test("exports default with fetch handler", () => {
    const wrapper = generateWorkerWrapper(
      "/project/worker/index.ts",
      "/project/.creek",
    );
    expect(wrapper).toContain("export default {");
    expect(wrapper).toContain("async fetch(request, env, ctx)");
  });

  test("handles nested entry paths", () => {
    const wrapper = generateWorkerWrapper(
      "/project/src/api/server.ts",
      "/project/.creek",
    );
    expect(wrapper).toContain('from "../src/api/server"');
  });

  test("handles entry in same directory", () => {
    const wrapper = generateWorkerWrapper(
      "/project/.creek/index.ts",
      "/project/.creek",
    );
    expect(wrapper).toContain('from "./index"');
  });

  test("resolves default export correctly (handles .default)", () => {
    const wrapper = generateWorkerWrapper(
      "/project/worker/index.ts",
      "/project/.creek",
    );
    expect(wrapper).toContain("userModule.default ?? userModule");
  });

  test("includes scheduled handler with _runRequest context", () => {
    const wrapper = generateWorkerWrapper(
      "/project/worker/index.ts",
      "/project/.creek",
    );
    expect(wrapper).toContain("async scheduled(event, env, ctx)");
    expect(wrapper).toContain('typeof handler.scheduled === "function"');
    // scheduled handler is wrapped in _runRequest
    const lines = wrapper.split("\n");
    const scheduledLine = lines.findIndex(l => l.includes("async scheduled("));
    const runRequestLine = lines.findIndex((l, i) => i > scheduledLine && l.includes("_runRequest(env, ctx"));
    expect(runRequestLine).toBeGreaterThan(scheduledLine);
  });

  test("includes queue handler with _runRequest context", () => {
    const wrapper = generateWorkerWrapper(
      "/project/worker/index.ts",
      "/project/.creek",
    );
    expect(wrapper).toContain("async queue(batch, env, ctx)");
    expect(wrapper).toContain('typeof handler.queue === "function"');
  });

  test("hasClientAssets variant also includes scheduled and queue handlers", () => {
    const wrapper = generateWorkerWrapper(
      "/project/worker/index.ts",
      "/project/.creek",
      { hasClientAssets: true },
    );
    expect(wrapper).toContain("async scheduled(event, env, ctx)");
    expect(wrapper).toContain("async queue(batch, env, ctx)");
  });

  describe("SPA deep-link fallback (worker + assets)", () => {
    test("embeds the provided index.html as the SPA shell", () => {
      const html = "<!doctype html><html><body><div id=root></div></body></html>";
      const wrapper = generateWorkerWrapper(
        "/project/worker/index.ts",
        "/project/.creek",
        { hasClientAssets: true, spaFallbackHtml: html },
      );
      // Embedded verbatim as a JSON string literal.
      expect(wrapper).toContain(`const SPA_SHELL = ${JSON.stringify(html)}`);
      expect(wrapper).toContain('"Content-Type": "text/html; charset=utf-8"');
    });

    test("does NOT rely on env.ASSETS (unbound under WfP)", () => {
      const wrapper = generateWorkerWrapper(
        "/project/worker/index.ts",
        "/project/.creek",
        { hasClientAssets: true, spaFallbackHtml: "<html></html>" },
      );
      expect(wrapper).not.toContain("env.ASSETS");
    });

    test("excludes /api/* from the SPA fallback so API 404s stay 404", () => {
      const wrapper = generateWorkerWrapper(
        "/project/worker/index.ts",
        "/project/.creek",
        { hasClientAssets: true, spaFallbackHtml: "<html></html>" },
      );
      expect(wrapper).toContain("isApiPath(url.pathname)");
      // The shell is only served for GET requests to extensionless paths.
      expect(wrapper).toContain('request.method === "GET"');
      expect(wrapper).toContain("!hasExtension(url.pathname)");
    });

    test("only serves the shell for browser navigations, not XHR/fetch 404s", () => {
      const wrapper = generateWorkerWrapper(
        "/project/worker/index.ts",
        "/project/.creek",
        { hasClientAssets: true, spaFallbackHtml: "<html></html>" },
      );
      // Gated on a document-navigation signal so an XHR/fetch to a missing
      // route keeps its real 404 instead of getting HTML.
      expect(wrapper).toContain("isNavigation(request)");
      expect(wrapper).toContain("Sec-Fetch-Dest");
      expect(wrapper).toContain('"text/html"');
    });

    test("SPA_SHELL is null when no index.html is available (no regression)", () => {
      const wrapper = generateWorkerWrapper(
        "/project/worker/index.ts",
        "/project/.creek",
        { hasClientAssets: true },
      );
      expect(wrapper).toContain("const SPA_SHELL = null");
    });
  });
});
