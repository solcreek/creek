import { describe, expect, it } from "vitest";
import { MainModuleError, mainModuleProblem, selectMainModule } from "./main-module";

describe("selectMainModule", () => {
  it("runs the declared module even when a guessed name is also uploaded", () => {
    expect(selectMainModule(["worker.js", "custom.js"], "custom.js")).toBe("custom.js");
    expect(selectMainModule(["index.js", "worker.js"], "index.js")).toBe("index.js");
  });

  it("accepts a declared module in a subdirectory", () => {
    expect(selectMainModule(["chunks/a.js", "server/entry.js"], "server/entry.js")).toBe(
      "server/entry.js",
    );
  });

  it("refuses a declared module that was not uploaded", () => {
    expect(() => selectMainModule(["worker.js"], "index.js")).toThrow(MainModuleError);
    expect(() => selectMainModule([], "index.js")).toThrow(/not one of the uploaded/);
  });

  describe("without a declaration (older clients): the name-based guess", () => {
    it("first guessed name in upload order", () => {
      expect(selectMainModule(["chunk.js", "index.js", "worker.js"])).toBe("index.js");
      expect(selectMainModule(["worker.js", "index.js"], null)).toBe("worker.js");
    });

    it("entry.mjs counts (Astro's adapter entry)", () => {
      expect(selectMainModule(["_adapter.mjs", "chunks/x.mjs", "entry.mjs"])).toBe("entry.mjs");
    });

    it("else the first file", () => {
      expect(selectMainModule(["a.mjs", "b.mjs"])).toBe("a.mjs");
    });

    it("a nested file with a guessed name is not a match", () => {
      // ssr/index.js comes second, so only a basename match would pick it.
      expect(selectMainModule(["app.js", "ssr/index.js"])).toBe("app.js");
    });
  });
});

describe("mainModuleProblem", () => {
  it("nothing declared is fine", () => {
    expect(mainModuleProblem(["worker.js"], undefined)).toBeNull();
    expect(mainModuleProblem(["worker.js"], null)).toBeNull();
  });

  it("rejects a non-string or empty declaration", () => {
    expect(mainModuleProblem(["worker.js"], "")).toMatch(/non-empty string/);
    expect(mainModuleProblem(["worker.js"], 42 as unknown as string)).toMatch(/non-empty string/);
  });
});
