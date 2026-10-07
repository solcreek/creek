import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import { processResourceCleanupQueue } from "./cleanup-queue.js";

const deletes: string[] = [];
let respond: (url: string) => Response = () =>
  HttpResponse.json({ success: true, result: {}, errors: [] });
const server = setupServer(
  http.delete("https://api.cloudflare.com/client/v4/*", ({ request }) => {
    deletes.push(new URL(request.url).pathname);
    return respond(request.url);
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  deletes.length = 0;
  respond = () => HttpResponse.json({ success: true, result: {}, errors: [] });
  server.resetHandlers();
});
afterAll(() => server.close());

let testEnv: LocalTestEnv;
beforeEach(() => {
  testEnv = createLocalTestEnv();
  testEnv.env.CLOUDFLARE_ACCOUNT_ID = "acc";
  testEnv.env.CLOUDFLARE_API_TOKEN = "t";
});
afterEach(() => testEnv.cleanup());

function queue(resourceType: string, cfResourceId: string, cfResourceName = cfResourceId) {
  testEnv.db.db
    .prepare(
      `INSERT INTO resource_cleanup_queue (resourceType, cfResourceId, cfResourceName, status, reason, createdAt)
       VALUES (?, ?, ?, 'pending', 'resource_deleted', ?)`,
    )
    .run(resourceType, cfResourceId, cfResourceName, Math.floor(Date.now() / 1000));
}
const statuses = () =>
  (
    testEnv.db.db
      .prepare("SELECT cfResourceId, status FROM resource_cleanup_queue ORDER BY id")
      .all() as Array<{
      cfResourceId: string;
      status: string;
    }>
  ).map((r) => `${r.cfResourceId}:${r.status}`);

describe("processResourceCleanupQueue", () => {
  it("deletes each queued D1, R2 bucket and KV namespace and marks them done", async () => {
    queue("d1", "d1-uuid");
    queue("r2", "bucket-id", "creek-bucket");
    queue("kv", "kv-id");

    expect(await processResourceCleanupQueue(testEnv.env)).toBe(3);

    expect(deletes).toEqual([
      "/client/v4/accounts/acc/d1/database/d1-uuid",
      "/client/v4/accounts/acc/r2/buckets/creek-bucket",
      "/client/v4/accounts/acc/storage/kv/namespaces/kv-id",
    ]);
    expect(statuses()).toEqual(["d1-uuid:done", "bucket-id:done", "kv-id:done"]);
  });

  it("treats a resource Cloudflare no longer has as done", async () => {
    queue("d1", "gone");
    respond = () =>
      HttpResponse.json(
        { success: false, errors: [{ code: 7404, message: "not found" }] },
        { status: 404 },
      );

    await processResourceCleanupQueue(testEnv.env);

    expect(statuses()).toEqual(["gone:done"]);
  });

  it("marks a delete Cloudflare refused as failed, not done", async () => {
    queue("d1", "refused");
    queue("kv", "fine");
    respond = (url) =>
      url.includes("refused")
        ? HttpResponse.json(
            { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
            { status: 403 },
          )
        : HttpResponse.json({ success: true, result: {}, errors: [] });

    expect(await processResourceCleanupQueue(testEnv.env)).toBe(1);

    expect(statuses()).toEqual(["refused:failed", "fine:done"]);
  });

  it("a custom hostname with no zone configured needs no API call", async () => {
    queue("custom_hostname", "cfh-1", "app.example.com");
    testEnv.env.CLOUDFLARE_ZONE_ID = undefined as unknown as string;

    await processResourceCleanupQueue(testEnv.env);

    expect(deletes).toEqual([]);
    expect(statuses()).toEqual(["cfh-1:done"]);
  });
});
