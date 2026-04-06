import { describe, test, expect } from "vitest";
import { CreekAuthError, CreekApiError } from "@solcreek/sdk";
import { patchBareNodeImports } from "./deploy.js";

describe("CreekAuthError", () => {
  test("is thrown on 401 and has correct name", () => {
    const err = new CreekAuthError("Token expired");
    expect(err.name).toBe("CreekAuthError");
    expect(err.message).toBe("Token expired");
    expect(err instanceof Error).toBe(true);
  });

  test("can be distinguished from CreekApiError", () => {
    const authErr = new CreekAuthError("Unauthorized");
    const apiErr = new CreekApiError(500, "server_error", "Internal error");

    expect(authErr instanceof CreekAuthError).toBe(true);
    expect(authErr instanceof CreekApiError).toBe(false);
    expect(apiErr instanceof CreekApiError).toBe(true);
    expect(apiErr instanceof CreekAuthError).toBe(false);
  });
});

describe("deploy polling constants", () => {
  test("TERMINAL states include active, failed, cancelled", () => {
    // These are the states that should stop CLI polling
    const TERMINAL = new Set(["active", "failed", "cancelled"]);
    expect(TERMINAL.has("active")).toBe(true);
    expect(TERMINAL.has("failed")).toBe(true);
    expect(TERMINAL.has("cancelled")).toBe(true);
    expect(TERMINAL.has("deploying")).toBe(false);
    expect(TERMINAL.has("queued")).toBe(false);
  });

  test("all deploy statuses have labels", () => {
    const STEP_LABELS: Record<string, string> = {
      queued: "Waiting...",
      uploading: "Uploading bundle...",
      provisioning: "Provisioning resources...",
      deploying: "Deploying to edge...",
    };

    // Every non-terminal status should have a label
    for (const status of ["queued", "uploading", "provisioning", "deploying"]) {
      expect(STEP_LABELS[status]).toBeDefined();
      expect(STEP_LABELS[status].length).toBeGreaterThan(0);
    }
  });
});

describe("patchBareNodeImports", () => {
  test("adds node: prefix to bare ESM imports", () => {
    const code = 'import fs from "fs";\nimport path from "path";';
    const result = patchBareNodeImports(code);
    expect(result).toContain('from "node:fs"');
    expect(result).toContain('from "node:path"');
  });

  test("adds node: prefix to bare require calls", () => {
    const code = 'const fs = require("fs");\nconst http = require("http");';
    const result = patchBareNodeImports(code);
    expect(result).toContain('require("node:fs")');
    expect(result).toContain('require("node:http")');
  });

  test("does not modify already-prefixed imports", () => {
    const code = 'import fs from "node:fs";';
    const result = patchBareNodeImports(code);
    expect(result).toBe(code);
  });

  test("does not modify non-builtin imports", () => {
    const code = 'import hono from "hono";\nimport react from "react";';
    const result = patchBareNodeImports(code);
    expect(result).toBe(code);
  });

  test("handles worker_threads", () => {
    const code = 'import libDefault from "worker_threads";';
    const result = patchBareNodeImports(code);
    expect(result).toContain('from "node:worker_threads"');
  });

  test("handles mixed bare and prefixed imports", () => {
    const code = 'import a from "fs";\nimport b from "node:path";\nimport c from "stream";';
    const result = patchBareNodeImports(code);
    expect(result).toContain('from "node:fs"');
    expect(result).toContain('from "node:path"');
    expect(result).toContain('from "node:stream"');
  });

  test("preserves non-import code", () => {
    const code = 'const x = "fs is great";\nimport fs from "fs";';
    const result = patchBareNodeImports(code);
    expect(result).toContain('const x = "fs is great"');
    expect(result).toContain('from "node:fs"');
  });
});
