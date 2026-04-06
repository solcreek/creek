import { describe, test, expect } from "vitest";
import { generateQrSvg } from "./qr.js";

describe("generateQrSvg", () => {
  test("generates valid SVG for a short URL", () => {
    const svg = generateQrSvg("https://abc12345.creeksandbox.com");
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("<path");
    expect(svg).toContain('fill="#000"');
    expect(svg).toContain('fill="#fff"');
  });

  test("generates different SVGs for different URLs", () => {
    const svg1 = generateQrSvg("https://aaa.creeksandbox.com");
    const svg2 = generateQrSvg("https://bbb.creeksandbox.com");
    expect(svg1).not.toBe(svg2);
  });

  test("handles longer URLs (version auto-select)", () => {
    const svg = generateQrSvg("https://abc12345.creeksandbox.com/some/longer/path?query=value");
    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
  });

  test("SVG has reasonable dimensions", () => {
    const svg = generateQrSvg("https://test.creeksandbox.com");
    const widthMatch = svg.match(/width="(\d+)"/);
    expect(widthMatch).toBeTruthy();
    const width = parseInt(widthMatch![1]);
    expect(width).toBeGreaterThan(40);
    expect(width).toBeLessThan(300);
  });
});
