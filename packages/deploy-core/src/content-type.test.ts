import { describe, expect, it } from "vitest";
import { inferContentType } from "./content-type.js";

describe("inferContentType", () => {
  it("serves markdown as text/markdown, not a download (#60)", () => {
    expect(inferContentType("/index.md")).toBe("text/markdown; charset=utf-8");
    expect(inferContentType("/docs/intro.markdown")).toBe("text/markdown; charset=utf-8");
    expect(inferContentType("/README.MD")).toBe("text/markdown; charset=utf-8");
  });

  it("keeps the existing mappings", () => {
    expect(inferContentType("/_june/client.feeaa6ef.js")).toBe("text/javascript; charset=utf-8");
    expect(inferContentType("/index.json")).toBe("application/json; charset=utf-8");
    expect(inferContentType("/icon.png")).toBe("image/png");
  });

  it("treats an extensionless path as an HTML route", () => {
    expect(inferContentType("/")).toBe("text/html; charset=utf-8");
    expect(inferContentType("/users")).toBe("text/html; charset=utf-8");
  });

  it("falls back to octet-stream for an unknown extension", () => {
    expect(inferContentType("/archive.xyz")).toBe("application/octet-stream");
  });
});
