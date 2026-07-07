import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createAssetUploadSession, uploadAssetFiles } from "./assets";
import type { DeployEnv } from "./types";

// MSW covers the CF Static Assets upload flow — the session request and the
// per-bucket file uploads (auth, form keys, completion jwt) — without real
// CF. hashAsset (pure) is covered in assets.test.ts. Fabricated IDs only.
const env: DeployEnv = {
  CLOUDFLARE_API_TOKEN: "test-token",
  CLOUDFLARE_ACCOUNT_ID: "test-account",
  DISPATCH_NAMESPACE: "creek-user-workers",
};

const SESSION_URL =
  "https://api.cloudflare.com/client/v4/accounts/:acc/workers/dispatch/namespaces/:ns/scripts/:name/assets-upload-session";
const UPLOAD_URL = "https://api.cloudflare.com/client/v4/accounts/:acc/workers/assets/upload";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function buf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

describe("createAssetUploadSession", () => {
  it("POSTs the manifest and returns the session jwt + buckets", async () => {
    let body: unknown = null;
    server.use(
      http.post(SESSION_URL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          success: true,
          result: { jwt: "session-jwt", buckets: [["h1", "h2"]] },
          errors: [],
        });
      }),
    );
    const manifest = { "/a.js": { hash: "h1", size: 10 } };
    const session = await createAssetUploadSession(env, "creek-app-team", manifest);
    expect(session).toEqual({ jwt: "session-jwt", buckets: [["h1", "h2"]] });
    expect(body).toEqual({ manifest });
  });
});

describe("uploadAssetFiles", () => {
  it("uploads each bucket with the session jwt and returns the completion jwt", async () => {
    const forms: Array<Record<string, unknown>> = [];
    let auth = "";
    server.use(
      http.post(UPLOAD_URL, async ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        forms.push(Object.fromEntries((await request.formData()).entries()));
        return HttpResponse.json({ success: true, result: { jwt: "completion-jwt" }, errors: [] });
      }),
    );

    const assets = { "/a.js": buf("aaa"), "/b.js": buf("bbb") };
    const hashToPath = { h1: "/a.js", h2: "/b.js" };
    const jwt = await uploadAssetFiles(env, "upload-jwt", [["h1", "h2"]], assets, hashToPath);

    expect(jwt).toBe("completion-jwt");
    expect(auth).toBe("Bearer upload-jwt"); // session jwt, not the account token
    expect(Object.keys(forms[0])).toEqual(["h1", "h2"]); // form keyed by hash
  });

  it("skips hashes with no matching asset; returns the session completion jwt", async () => {
    const forms: Array<Record<string, unknown>> = [];
    let received = 0;
    const total = 2;
    server.use(
      http.post(UPLOAD_URL, async ({ request }) => {
        forms.push(Object.fromEntries((await request.formData()).entries()));
        received++;
        // Model CF: the completion jwt is returned only once every file is in
        // (the request that completes the session) — order-independent.
        const jwt = received === total ? "completion-jwt" : null;
        return HttpResponse.json({ success: true, result: { jwt }, errors: [] });
      }),
    );

    const assets = { "/a.js": buf("aaa") };
    const hashToPath = { h1: "/a.js" }; // "h-missing" has no path
    const jwt = await uploadAssetFiles(
      env,
      "upload-jwt",
      [["h1", "h-missing"], ["h1"]],
      assets,
      hashToPath,
    );

    expect(jwt).toBe("completion-jwt");
    // Both buckets uploaded; "h-missing" dropped (every form keyed only by h1).
    expect(forms).toHaveLength(2);
    expect(forms.every((f) => Object.keys(f).join() === "h1")).toBe(true);
  });

  it("uploads many buckets concurrently (bounded) and still returns the completion jwt", async () => {
    const N = 15;
    let received = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    server.use(
      http.post(UPLOAD_URL, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15)); // hold the connection so overlap is observable
        inFlight--;
        received++;
        return HttpResponse.json({
          success: true,
          result: { jwt: received === N ? "completion-jwt" : null },
          errors: [],
        });
      }),
    );

    const assets: Record<string, ArrayBuffer> = {};
    const hashToPath: Record<string, string> = {};
    const buckets: string[][] = [];
    for (let i = 0; i < N; i++) {
      assets[`/f${i}.js`] = buf(`content-${i}`);
      hashToPath[`h${i}`] = `/f${i}.js`;
      buckets.push([`h${i}`]);
    }

    const jwt = await uploadAssetFiles(env, "upload-jwt", buckets, assets, hashToPath);

    expect(received).toBe(N); // every bucket uploaded
    expect(jwt).toBe("completion-jwt"); // completion jwt captured despite ordering
    expect(maxInFlight).toBeGreaterThan(1); // actually concurrent
    expect(maxInFlight).toBeLessThanOrEqual(6); // but bounded by the pool
  });
});
