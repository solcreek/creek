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

  it("skips hashes with no matching asset and returns the last bucket's jwt", async () => {
    const forms: Array<Record<string, unknown>> = [];
    let call = 0;
    server.use(
      http.post(UPLOAD_URL, async ({ request }) => {
        forms.push(Object.fromEntries((await request.formData()).entries()));
        call++;
        return HttpResponse.json({ success: true, result: { jwt: `jwt-${call}` }, errors: [] });
      }),
    );

    const assets = { "/a.js": buf("aaa") };
    const hashToPath = { h1: "/a.js" }; // "h-missing" has no path
    const jwt = await uploadAssetFiles(env, "upload-jwt", [["h1", "h-missing"], ["h1"]], assets, hashToPath);

    expect(jwt).toBe("jwt-2"); // completion jwt comes from the last bucket
    expect(Object.keys(forms[0])).toEqual(["h1"]); // "h-missing" skipped
  });
});
