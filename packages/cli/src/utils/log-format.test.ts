import { describe, it, expect } from "vitest";

function parseCreekdLogLine(line: string): { ts: string; stream: string; msg: string } {
  try {
    const rec = JSON.parse(line);
    return { ts: rec.ts ?? "", stream: rec.stream ?? "stdout", msg: rec.msg ?? "" };
  } catch {
    return { ts: "", stream: "stdout", msg: line };
  }
}

describe("parseCreekdLogLine", () => {
  it("parses valid NDJSON log record", () => {
    const line = '{"ts":"2026-05-24T01:32:59.700857Z","app":"logger","stream":"stdout","msg":"hello world"}';
    const rec = parseCreekdLogLine(line);
    expect(rec.ts).toBe("2026-05-24T01:32:59.700857Z");
    expect(rec.stream).toBe("stdout");
    expect(rec.msg).toBe("hello world");
  });

  it("parses stderr stream", () => {
    const line = '{"ts":"2026-05-24T01:33:00Z","app":"api","stream":"stderr","msg":"Error: connection refused"}';
    const rec = parseCreekdLogLine(line);
    expect(rec.stream).toBe("stderr");
    expect(rec.msg).toBe("Error: connection refused");
  });

  it("handles non-JSON lines gracefully", () => {
    const rec = parseCreekdLogLine("plain text log line");
    expect(rec.ts).toBe("");
    expect(rec.stream).toBe("stdout");
    expect(rec.msg).toBe("plain text log line");
  });

  it("handles empty JSON object", () => {
    const rec = parseCreekdLogLine("{}");
    expect(rec.ts).toBe("");
    expect(rec.msg).toBe("");
  });

  it("handles msg with special characters", () => {
    const line = '{"ts":"2026-05-24T00:00:00Z","stream":"stdout","msg":"line with \\"quotes\\" and \\nnewlines"}';
    const rec = parseCreekdLogLine(line);
    expect(rec.msg).toContain("quotes");
  });
});
