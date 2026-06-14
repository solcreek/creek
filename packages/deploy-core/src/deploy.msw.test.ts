import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { deployScriptWithAssets } from "./deploy";
import type { DeployEnv, WfPBinding } from "./types";

// MSW lets us assert the exact metadata deploy-core PUTs to the Cloudflare
// WfP API — the compat flags / date, the Next.js DO bindings + migrations,
// and the migration-tag-precondition retry — without touching real CF. This
// is the layer that the node:http regression (nodejs_compat_v2 + an old
// compatibility_date) slipped through because it was previously untestable.

const env: DeployEnv = {
  CLOUDFLARE_API_TOKEN: "test-token",
  CLOUDFLARE_ACCOUNT_ID: "acc123",
  DISPATCH_NAMESPACE: "creek-user-workers",
};

const SCRIPT_URL =
  "https://api.cloudflare.com/client/v4/accounts/:acc/workers/dispatch/namespaces/:ns/scripts/:name";

// Captured metadata of every PUT, in order.
let puts: Array<Record<string, unknown>> = [];
// When >0, the first N PUTs fail with a migration-tag precondition error.
let failFirstWithMigrationError = 0;

// Structural type, not the global `Request` — deploy-core compiles against
// @cloudflare/workers-types, whose Request is incompatible with MSW's.
async function readMetadata(
  request: { formData(): Promise<FormData> },
): Promise<Record<string, unknown>> {
  const fd = await request.formData();
  const meta = fd.get("metadata");
  return JSON.parse(await (meta as File).text());
}

const server = setupServer(
  http.put(SCRIPT_URL, async ({ request }) => {
    puts.push(await readMetadata(request));
    if (failFirstWithMigrationError > 0) {
      failFirstWithMigrationError--;
      return HttpResponse.json({
        success: false,
        errors: [{ code: 10074, message: "migration tag precondition failed" }],
      });
    }
    return HttpResponse.json({ success: true, result: { id: "script" }, errors: [] });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  puts = [];
  failFirstWithMigrationError = 0;
  server.resetHandlers();
});
afterAll(() => server.close());

function workerFiles(): File[] {
  return [new File(["export default {}"], "worker.js", { type: "application/javascript+module" })];
}

// deployScriptWithAssets(env, scriptName, workerFiles, mainModule, completionJwt,
//   tags, bindings, assetsConfig?, cronSchedules?, compatibilityDate?, compatibilityFlags?, framework?)
function deploy(opts: {
  framework?: string | null;
  date?: string;
  flags?: string[];
  bindings?: WfPBinding[];
} = {}) {
  return deployScriptWithAssets(
    env,
    "creek-app-team",
    workerFiles(),
    "worker.js",
    "jwt",
    ["app:creek-app"],
    opts.bindings ?? [],
    undefined,
    undefined,
    opts.date,
    opts.flags,
    opts.framework,
  );
}

describe("deployScriptWithAssets — Cloudflare WfP metadata (via MSW)", () => {
  it("defaults a Next.js worker to nodejs_compat + date >= 2025-09-01", async () => {
    await deploy({ framework: "nextjs" });
    expect(puts).toHaveLength(1);
    expect(puts[0].compatibility_flags).toEqual(["nodejs_compat"]);
    expect(puts[0].compatibility_flags).not.toContain("nodejs_compat_v2");
    expect(String(puts[0].compatibility_date) >= "2025-09-01").toBe(true);
  });

  it("injects the Next.js DO bindings + a first-deploy migration", async () => {
    await deploy({ framework: "nextjs", bindings: [{ type: "d1", name: "DB" }] });
    const bindingNames = (puts[0].bindings as WfPBinding[]).map((b) => b.name);
    expect(bindingNames).toEqual(
      expect.arrayContaining(["DB", "NEXT_CACHE_DO_QUEUE", "NEXT_TAG_CACHE_DO_SHARDED", "NEXT_CACHE_DO_BUCKET_PURGE"]),
    );
    expect(puts[0].migrations).toMatchObject({
      new_sqlite_classes: ["DOQueueHandler", "DOShardedTagCache", "BucketCachePurge"],
    });
  });

  it("leaves non-Next.js workers on the conservative default, no DO bindings", async () => {
    await deploy({ framework: "vite-react", bindings: [{ type: "d1", name: "DB" }] });
    expect(puts[0].compatibility_flags).toEqual(["nodejs_compat"]);
    expect(puts[0].compatibility_date).toBe("2025-03-14");
    expect((puts[0].bindings as WfPBinding[]).map((b) => b.name)).toEqual(["DB"]);
    expect(puts[0].migrations).toBeUndefined();
  });

  it("prefers the bundle-declared compat over the default", async () => {
    await deploy({ framework: "nextjs", date: "2026-09-01", flags: ["nodejs_compat"] });
    expect(puts[0].compatibility_date).toBe("2026-09-01");
    expect(puts[0].compatibility_flags).toEqual(["nodejs_compat"]);
  });

  it("retries with migration_tag when the tag precondition fails", async () => {
    failFirstWithMigrationError = 1;
    await deploy({ framework: "nextjs" });
    expect(puts).toHaveLength(2);
    // First attempt carries the full migration...
    expect(puts[0].migrations).toBeDefined();
    // ...the retry drops it and sets the tag instead.
    expect(puts[1].migrations).toBeUndefined();
    expect(puts[1].migration_tag).toBe("v1");
  });
});
