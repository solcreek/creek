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
});
