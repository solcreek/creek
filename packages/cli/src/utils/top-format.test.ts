import { describe, it, expect } from "vitest";
import { fmtBytes, fmtDuration, calcCpuPercent } from "./top-format.js";

describe("fmtBytes", () => {
  it("formats bytes", () => {
    expect(fmtBytes(0)).toBe("0B");
    expect(fmtBytes(512)).toBe("512B");
    expect(fmtBytes(1023)).toBe("1023B");
  });

  it("formats kilobytes", () => {
    expect(fmtBytes(1024)).toBe("1.0K");
    expect(fmtBytes(64 * 1024)).toBe("64.0K");
  });

  it("formats megabytes", () => {
    expect(fmtBytes(1024 * 1024)).toBe("1.0M");
    expect(fmtBytes(50_000_000)).toBe("47.7M");
    expect(fmtBytes(256 * 1024 * 1024)).toBe("256.0M");
  });

  it("formats gigabytes", () => {
    expect(fmtBytes(1024 * 1024 * 1024)).toBe("1.0G");
    expect(fmtBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5G");
  });
});

describe("fmtDuration", () => {
  it("formats zero and sub-second", () => {
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(500)).toBe("0s");
    expect(fmtDuration(999)).toBe("0s");
  });

  it("formats seconds", () => {
    expect(fmtDuration(1000)).toBe("1s");
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(59_000)).toBe("59s");
  });

  it("formats minutes", () => {
    expect(fmtDuration(60_000)).toBe("1m");
    expect(fmtDuration(90_000)).toBe("1m30s");
    expect(fmtDuration(3_540_000)).toBe("59m");
  });

  it("formats hours", () => {
    expect(fmtDuration(3_600_000)).toBe("1h");
    expect(fmtDuration(3_723_000)).toBe("1h2m");
    expect(fmtDuration(15_780_000)).toBe("4h23m");
  });

  it("formats days", () => {
    expect(fmtDuration(86_400_000)).toBe("1d");
    expect(fmtDuration(90_000_000)).toBe("1d1h");
    expect(fmtDuration(7 * 86_400_000)).toBe("7d");
  });
});

describe("calcCpuPercent", () => {
  it("returns CPU percentage from delta", () => {
    // 1_000_000 usec over 1000ms = 100% of one core
    const pct = calcCpuPercent(0, 0, 1_000_000, 1000);
    expect(pct).toBeCloseTo(100.0);
  });

  it("returns partial CPU usage", () => {
    // 500_000 usec over 2000ms = 25%
    const pct = calcCpuPercent(0, 0, 500_000, 2000);
    expect(pct).toBeCloseTo(25.0);
  });

  it("handles incremental deltas", () => {
    // prev: 10_000_000 usec at t=5000ms
    // curr: 10_200_000 usec at t=7000ms
    // delta: 200_000 usec over 2000ms = 10%
    const pct = calcCpuPercent(10_000_000, 5000, 10_200_000, 7000);
    expect(pct).toBeCloseTo(10.0);
  });

  it("returns null for zero time delta", () => {
    expect(calcCpuPercent(0, 1000, 500_000, 1000)).toBeNull();
  });

  it("returns null for negative time delta", () => {
    expect(calcCpuPercent(0, 2000, 500_000, 1000)).toBeNull();
  });

  it("returns 0 for no CPU usage", () => {
    const pct = calcCpuPercent(1_000_000, 0, 1_000_000, 2000);
    expect(pct).toBeCloseTo(0);
  });
});
