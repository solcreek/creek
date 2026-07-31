/**
 * End-to-end assertion of what `deployWithAssets` actually sends to the
 * Cloudflare API for `_headers` / `_redirects`.
 *
 * Reported 2026-07-24: a tenant's `public/_headers` had no effect in
 * production. `wrangler dev` applied it, so they shipped believing it was
 * fixed, and closed then reopened their own issue over the false positive.
 *
 * Two bugs, both only visible at this boundary:
 *   - the file was uploaded as an ordinary asset (GET /_headers → 200)
 *   - `assets.config` went out as `{}`, so the rules were never applied
 *     and `/_next/static/*` kept `public, max-age=0, must-revalidate`
 *
 * Unit tests on the extractor can't catch either — only the request the
 * API receives can. Hence MSW rather than a mocked helper.
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

const HEADERS_RULE = "/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable\n";

function input(overrides: Partial<DeployAssetsInput> = {}): DeployAssetsInput {
  return {
    clientAssets: { "/index.html": enc("<html>") },
    renderMode: "spa",
    teamId: "team_1",
    teamSlug: "eli-chen-f443",
    projectSlug: "nii-course-system",
    plan: "free",
    bindings: [],
    ...overrides,
  };
}

const ssr = (clientAssets: Record<string, ArrayBuffer>): DeployAssetsInput =>
  input({
    clientAssets,
    renderMode: "ssr",
    serverFiles: { "worker.js": enc("export default {}") },
    framework: "nextjs",
  } as Partial<DeployAssetsInput>);

/** `assets.config` from the first script PUT. */
const config = (): Record<string, unknown> =>
  (puts[0].assets as { config: Record<string, unknown> }).config;

describe("_headers reaches the API as configuration", () => {
  it("SSR: the rules are sent in assets.config", async () => {
    // The exact regression. SSR left assetsConfig undefined, so the API
    // received `config: {}` and dropped the rules on the floor.
    await deployWithAssets(
      env,
      "nii-course-system",
      "eli-chen-f443",
      "dep_12345678",
      ssr({
        "/index.html": enc("<html>"),
        "/_headers": enc(HEADERS_RULE),
      }),
    );

    expect(config()._headers).toBe(HEADERS_RULE);
  });

  it("SPA: the rules are sent in assets.config", async () => {
    await deployWithAssets(
      env,
      "nii-course-system",
      "eli-chen-f443",
      "dep_12345678",
      input({ clientAssets: { "/index.html": enc("<html>"), "/_headers": enc(HEADERS_RULE) } }),
    );

    expect(config()._headers).toBe(HEADERS_RULE);
  });

  it("_redirects rides along in the same config object", async () => {
    await deployWithAssets(
      env,
      "nii-course-system",
      "eli-chen-f443",
      "dep_12345678",
      ssr({
        "/index.html": enc("<html>"),
        "/_headers": enc(HEADERS_RULE),
        "/_redirects": enc("/old /new 301\n"),
      }),
    );

    expect(config()._headers).toBe(HEADERS_RULE);
    expect(config()._redirects).toBe("/old /new 301\n");
  });

  it("a project without the files still sends a valid empty config", async () => {
    await deployWithAssets(env, "nii-course-system", "eli-chen-f443", "dep_12345678", input());

    expect(config()).toEqual({});
  });
});

describe("_headers is never served as an asset", () => {
  it("is absent from the upload manifest", async () => {
    // Production served the tenant's own file at GET /_headers, comments
    // and all. Lifting the content is only half the fix.
    await deployWithAssets(
      env,
      "nii-course-system",
      "eli-chen-f443",
      "dep_12345678",
      ssr({
        "/index.html": enc("<html>"),
        "/_headers": enc(HEADERS_RULE),
        "/_redirects": enc("/old /new 301\n"),
      }),
    );

    expect(manifests.length).toBeGreaterThan(0);
    for (const manifest of manifests) {
      expect(Object.keys(manifest)).toContain("/index.html");
      expect(Object.keys(manifest)).not.toContain("/_headers");
      expect(Object.keys(manifest)).not.toContain("/_redirects");
    }
  });

  it("keeps a nested _headers as an ordinary asset", async () => {
    await deployWithAssets(
      env,
      "nii-course-system",
      "eli-chen-f443",
      "dep_12345678",
      ssr({
        "/index.html": enc("<html>"),
        "/docs/_headers": enc("not config"),
      }),
    );

    expect(Object.keys(manifests[0])).toContain("/docs/_headers");
    expect(config()._headers).toBeUndefined();
  });
});
