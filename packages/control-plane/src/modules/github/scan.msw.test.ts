import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { scanRepo } from "./scan";

// Integration: drives scanRepo through the REAL getRepoContents -> githubFetch
// path with MSW mocking the GitHub Contents API. Complements scan.test.ts
// (which mocks getRepoContents at the boundary) and also exercises
// getRepoContents' base64 decode + 404 handling. Fabricated content only.
const CONTENTS = "https://api.github.com/repos/:owner/:repo/contents/*";

// GitHub Contents API returns file bodies base64-encoded.
function file(content: string) {
  return HttpResponse.json({ content: btoa(content), encoding: "base64" });
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Route each requested path to its fixture; 404 for anything not provided.
function withFiles(files: Record<string, string>) {
  server.use(
    http.get(CONTENTS, ({ request }) => {
      const path = decodeURIComponent(new URL(request.url).pathname.split("/contents/")[1]);
      if (path in files) return file(files[path]);
      return new HttpResponse("Not Found", { status: 404 });
    }),
  );
}

describe("scanRepo (via MSW)", () => {
  it("detects framework, wrangler config, bindings, and env hints", async () => {
    withFiles({
      "package.json": JSON.stringify({ dependencies: { next: "16.2.9" } }),
      "wrangler.toml": [
        'name = "app"',
        "[[d1_databases]]",
        'binding = "DB"',
        'database_name = "mydb"',
      ].join("\n"),
      ".env.example": "API_KEY=\n# a comment\nDATABASE_URL=postgres://x\nlowercase_ignored=1",
    });

    const result = await scanRepo("tok", "myorg", "app");

    expect(result.framework).toBeTruthy(); // SDK recognized the next dependency
    expect(result.configType).toBe("wrangler.toml");
    expect(result.bindings).toContainEqual({ type: "d1", name: "DB" });
    expect(result.envHints).toEqual(["API_KEY", "DATABASE_URL"]); // lowercase + comments dropped
    expect(result.deployable).toBe(true);
  });

  it("prefers wrangler.jsonc over .toml when both exist (first found wins)", async () => {
    withFiles({
      "wrangler.jsonc": '{ "name": "app", "kv_namespaces": [{ "binding": "CACHE" }] }',
      "wrangler.toml": 'name = "app"\n[[d1_databases]]\nbinding = "DB"',
    });
    const result = await scanRepo("tok", "myorg", "app");
    expect(result.configType).toBe("wrangler.jsonc");
    expect(result.bindings).toContainEqual({ type: "kv", name: "CACHE" });
    expect(result.bindings).not.toContainEqual({ type: "d1", name: "DB" }); // .toml not parsed
  });

  it("reports not deployable for an empty repo (all files 404)", async () => {
    withFiles({});
    const result = await scanRepo("tok", "myorg", "empty");
    expect(result).toMatchObject({
      framework: null,
      configType: null,
      bindings: [],
      deployable: false,
    });
  });
});
