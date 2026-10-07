import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import { processResourceCleanupQueue } from "./cleanup-queue.js";

const deletes: string[] = [];
let respond: (url: string) => Response = () =>
  HttpResponse.json({ success: true, result: {}, errors: [] });
// What Cloudflare reports for each D1/KV id: its name (D1) or title (KV).
let names: Record<string, string> = {};
const server = setupServer(
  http.delete("https://api.cloudflare.com/client/v4/*", ({ request }) => {
    deletes.push(new URL(request.url).pathname);
    return respond(request.url);
  }),
  http.get("https://api.cloudflare.com/client/v4/accounts/:acc/d1/database/:id", ({ params }) => {
    const name = names[params.id as string];
    return name
      ? HttpResponse.json({ success: true, result: { uuid: params.id, name }, errors: [] })
      : HttpResponse.json(
          { success: false, errors: [{ code: 7404, message: "not found" }] },
          { status: 404 },
        );
  }),
  http.get(
    "https://api.cloudflare.com/client/v4/accounts/:acc/storage/kv/namespaces/:id",
    ({ params }) => {
      const title = names[params.id as string];
      return title
        ? HttpResponse.json({ success: true, result: { id: params.id, title }, errors: [] })
        : HttpResponse.json(
            { success: false, errors: [{ code: 10013, message: "not found" }] },
            { status: 404 },
          );
    },
  ),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  deletes.length = 0;
  names = {};
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
    names = { "d1-uuid": "creek-aaaa1111", "kv-id": "creek-cccc3333" };
    queue("d1", "d1-uuid", "creek-aaaa1111");
    queue("r2", "creek-bbbb2222", "creek-bbbb2222");
    queue("kv", "kv-id", "creek-cccc3333");

    expect(await processResourceCleanupQueue(testEnv.env)).toBe(3);

    expect(deletes).toEqual([
      "/client/v4/accounts/acc/d1/database/d1-uuid",
      "/client/v4/accounts/acc/r2/buckets/creek-bbbb2222",
      "/client/v4/accounts/acc/storage/kv/namespaces/kv-id",
    ]);
    expect(statuses()).toEqual(["d1-uuid:done", "creek-bbbb2222:done", "kv-id:done"]);
  });

  it("refuses to delete a resource that isn't the one Creek provisioned", async () => {
    // A resource row whose cfResourceId was supplied by the caller and points
    // at someone else's database: its name is not this row's creek-<id8>.
    names = { "victim-d1": "creek-victim00", "victim-kv": "prod-sessions" };
    queue("d1", "victim-d1", "creek-attacker");
    queue("kv", "victim-kv", "creek-attacker");
    queue("r2", "someone-elses-bucket", "creek-attacker");

    expect(await processResourceCleanupQueue(testEnv.env)).toBe(0);

    expect(deletes).toEqual([]);
    expect(statuses()).toEqual([
      "victim-d1:failed",
      "victim-kv:failed",
      "someone-elses-bucket:failed",
    ]);
  });

  it("treats a resource Cloudflare no longer has as done", async () => {
    queue("d1", "gone", "creek-gone0000");

    await processResourceCleanupQueue(testEnv.env);

    expect(deletes).toEqual([]);
    expect(statuses()).toEqual(["gone:done"]);
  });

  it("treats a delete that answers 404 as done", async () => {
    names = { raced: "creek-raced000" };
    queue("d1", "raced", "creek-raced000");
    respond = () =>
      HttpResponse.json(
        { success: false, errors: [{ code: 7404, message: "not found" }] },
        { status: 404 },
      );

    await processResourceCleanupQueue(testEnv.env);

    expect(statuses()).toEqual(["raced:done"]);
  });

  it("marks a delete Cloudflare refused as failed, not done", async () => {
    names = { refused: "creek-refused0", fine: "creek-fine0000" };
    queue("d1", "refused", "creek-refused0");
    queue("kv", "fine", "creek-fine0000");
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
