/**
 * What `deployWithAssets` sends for a user-declared worker's static assets:
 * an `ASSETS` binding and, when asked, `run_worker_first` (solcreek/creek#56).
 * Workers for Platforms honours both for dispatched user workers (verified
 * 2026-09-28); framework SSR bundles and the SPA worker must not get the
 * binding, because some of them change behaviour when `env.ASSETS` exists.
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
const SESSION_URL = `${BASE}/scripts/:name/assets-upload-session`;
const SCRIPT_URL = `${BASE}/scripts/:name`;
const SETTINGS_URL = `${SCRIPT_URL}/settings`;

/** Manifests posted to the upload-session endpoint, in order. */
let manifests: Array<Record<string, unknown>> = [];
/** Script-upload metadata PUT to the API, in order. */
let puts: Array<Record<string, unknown>> = [];

const server = setupServer(
  http.post(SESSION_URL, async ({ request }) => {
    const body = (await request.json()) as { manifest: Record<string, unknown> };
    manifests.push(body.manifest);
    // No buckets → nothing to upload, so the flow proceeds straight to PUT.
    return HttpResponse.json({ success: true, result: { jwt: "jwt-token", buckets: [] } });
  }),
  http.put(SCRIPT_URL, async ({ request }) => {
    const fd = await (request as { formData(): Promise<FormData> }).formData();
    puts.push(JSON.parse(await (fd.get("metadata") as File).text()));
    return HttpResponse.json({ success: true, result: { id: "script" }, errors: [] });
  }),
  http.patch(SETTINGS_URL, () => HttpResponse.json({ success: true, result: {}, errors: [] })),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  manifests = [];
  puts = [];
  server.resetHandlers();
});
afterAll(() => server.close());

const enc = (s: string): ArrayBuffer => {
  const bytes = new TextEncoder().encode(s);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

function input(overrides: Partial<DeployAssetsInput> = {}): DeployAssetsInput {
  return {
    clientAssets: { "/index.html": enc("<html>") },
    renderMode: "worker",
    serverFiles: { "worker.js": enc("export default {}") },
    teamId: "team_1",
    teamSlug: "acme",
    projectSlug: "site",
    plan: "free",
    bindings: [{ type: "d1", name: "DB", id: "db-1" }],
    ...overrides,
  };
}

async function deploy(overrides: Partial<DeployAssetsInput> = {}) {
  await deployWithAssets(env, "site", "acme", "dep_12345678", input(overrides));
  return puts[0] as {
    bindings: Array<{ type: string; name: string }>;
    assets: { config: Record<string, unknown> };
  };
}

describe("user-declared worker: static assets", () => {
  it("binds ASSETS alongside the project's own bindings", async () => {
    const meta = await deploy();
    expect(meta.bindings).toEqual([
      { type: "d1", name: "DB", id: "db-1" },
      { type: "assets", name: "ASSETS" },
    ]);
    expect(meta.assets.config.run_worker_first).toBeUndefined();
  });

  it("passes run_worker_first: true through to assets.config", async () => {
    const meta = await deploy({ runWorkerFirst: true });
    expect(meta.assets.config.run_worker_first).toBe(true);
  });

  it("passes route patterns through unchanged", async () => {
    const meta = await deploy({ runWorkerFirst: ["/api/*", "!/api/public/*"] });
    expect(meta.assets.config.run_worker_first).toEqual(["/api/*", "!/api/public/*"]);
  });

  it("keeps a user binding already named ASSETS instead of adding a second one", async () => {
    const meta = await deploy({
      bindings: [{ type: "r2_bucket", name: "ASSETS", bucket_name: "b" }],
    });
    expect(meta.bindings.filter((b) => b.name === "ASSETS")).toEqual([
      { type: "r2_bucket", name: "ASSETS", bucket_name: "b" },
    ]);
  });

  it("sends run_worker_first to every script (production and branch aliases)", async () => {
    await deployWithAssets(
      env,
      "site",
      "acme",
      "dep_12345678",
      input({ runWorkerFirst: true }),
      "feat-x",
      "main",
    );
    expect(puts.length).toBeGreaterThan(1);
    for (const put of puts as Array<{ assets: { config: Record<string, unknown> } }>) {
      expect(put.assets.config.run_worker_first).toBe(true);
    }
  });
});

describe("other render modes are unchanged", () => {
  it("framework SSR gets no ASSETS binding and ignores run_worker_first", async () => {
    const meta = await deploy({ renderMode: "ssr", runWorkerFirst: true });
    expect(meta.bindings.some((b) => b.name === "ASSETS")).toBe(false);
    expect(meta.assets.config.run_worker_first).toBeUndefined();
  });

  it("SPA gets no ASSETS binding", async () => {
    const meta = await deploy({ renderMode: "spa", serverFiles: undefined, bindings: [] });
    expect(meta.bindings).toEqual([]);
  });
});
