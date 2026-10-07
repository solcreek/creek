/**
 * The worker's main module as `deployWithAssets` sends it to the Workers
 * upload API: the bundle's declared `mainModule` when there is one, else the
 * name-based guess older clients rely on. A declaration that names no
 * uploaded file fails the deploy before any API call.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { deployWithAssets } from "./deploy";
import type { DeployEnv, DeployAssetsInput } from "./types";

const env: DeployEnv = {
  CLOUDFLARE_API_TOKEN: "test-token",
  CLOUDFLARE_ACCOUNT_ID: "acc123",
  DISPATCH_NAMESPACE: "creek-user-workers",
};

const BASE = "https://api.cloudflare.com/client/v4/accounts/:acc/workers/dispatch/namespaces/:ns";
const SCRIPT_URL = `${BASE}/scripts/:name`;

let requests = 0;
/** Each script upload: its metadata and the module parts it carried. */
let uploads: Array<{ mainModule: string; parts: string[] }> = [];

const server = setupServer(
  http.post(`${SCRIPT_URL}/assets-upload-session`, () => {
    requests++;
    return HttpResponse.json({ success: true, result: { jwt: "jwt", buckets: [] } });
  }),
  http.put(SCRIPT_URL, async ({ request }) => {
    requests++;
    const fd = await (request as { formData(): Promise<FormData> }).formData();
    const metadata = JSON.parse(await (fd.get("metadata") as File).text());
    const parts = [...fd.keys()].filter((k) => k !== "metadata");
    uploads.push({ mainModule: metadata.main_module, parts });
    return HttpResponse.json({ success: true, result: { id: "script" }, errors: [] });
  }),
  http.patch(`${SCRIPT_URL}/settings`, () =>
    HttpResponse.json({ success: true, result: {}, errors: [] }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  requests = 0;
  uploads = [];
  server.resetHandlers();
});
afterAll(() => server.close());

const js = (s: string): ArrayBuffer => {
  const b = new TextEncoder().encode(s);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

function input(overrides: Partial<DeployAssetsInput>): DeployAssetsInput {
  return {
    clientAssets: { "/index.html": js("<html>") },
    renderMode: "worker",
    teamId: "team_1",
    teamSlug: "acme",
    projectSlug: "site",
    plan: "free",
    bindings: [],
    ...overrides,
  };
}

const deploy = (overrides: Partial<DeployAssetsInput>) =>
  deployWithAssets(env, "site", "acme", "dep_12345678", input(overrides));

describe("deployWithAssets — main module", () => {
  it("uploads the declared module as main_module, though worker.js is also present", async () => {
    await deploy({
      serverFiles: { "worker.js": js("export default {}"), "index.js": js("export default {}") },
      mainModule: "index.js",
    });
    expect(uploads.length).toBeGreaterThan(0);
    for (const u of uploads) {
      expect(u.mainModule).toBe("index.js");
      expect(u.parts.sort()).toEqual(["index.js", "worker.js"]);
    }
  });

  it("a declared name no guess would pick", async () => {
    await deploy({
      serverFiles: { "chunk.js": js("export {}"), "app.mjs": js("export default {}") },
      mainModule: "app.mjs",
    });
    expect(uploads.every((u) => u.mainModule === "app.mjs")).toBe(true);
  });

  it("without a declaration, guesses as before", async () => {
    await deploy({
      serverFiles: { "chunk.js": js("export {}"), "index.js": js("export default {}") },
    });
    expect(uploads.every((u) => u.mainModule === "index.js")).toBe(true);
  });

  it("a declared module that was not uploaded fails before any API call", async () => {
    await expect(
      deploy({ serverFiles: { "worker.js": js("export default {}") }, mainModule: "index.js" }),
    ).rejects.toThrow(/not one of the uploaded server files/);
    expect(requests).toBe(0);
  });

  it("an SPA deploy ignores it and uploads the generated worker", async () => {
    await deploy({ renderMode: "spa", serverFiles: undefined, mainModule: null });
    expect(uploads.every((u) => u.mainModule === "worker.mjs")).toBe(true);
  });
});
