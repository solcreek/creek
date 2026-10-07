import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import { MAX_ATTEMPTS, processResourceCleanupQueue } from "./cleanup-queue.js";

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
const row = (cfResourceId: string) =>
  testEnv.db.db
    .prepare(
      "SELECT status, attempts, claimedAt, nextAttemptAt FROM resource_cleanup_queue WHERE cfResourceId = ?",
    )
    .get(cfResourceId) as {
    status: string;
    attempts: number;
    claimedAt: number | null;
    nextAttemptAt: number | null;
  };
const nowSec = () => Math.floor(Date.now() / 1000);
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

  it("deletes a queued Cloudflare queue that still has its provisioned name", async () => {
    server.use(
      http.get("https://api.cloudflare.com/client/v4/accounts/:acc/queues/:id", ({ params }) =>
        HttpResponse.json({
          success: true,
          result: {
            queue_id: params.id,
            queue_name: params.id === "q-mine" ? "creek-q-mine0000" : "orders",
          },
          errors: [],
        }),
      ),
    );
    queue("queue", "q-mine", "creek-q-mine0000");
    queue("queue", "q-other", "creek-q-mine0000");

    await processResourceCleanupQueue(testEnv.env);

    expect(deletes).toEqual(["/client/v4/accounts/acc/queues/q-mine"]);
    expect(statuses()).toEqual(["q-mine:done", "q-other:failed"]);
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

  it("puts a delete Cloudflare refused back in the queue with backoff, not done", async () => {
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

    expect(statuses()).toEqual(["refused:pending", "fine:done"]);
    const retried = row("refused");
    expect(retried.attempts).toBe(1);
    // First retry no sooner than 5 minutes out.
    expect(retried.nextAttemptAt).toBeGreaterThanOrEqual(nowSec() + 5 * 60 - 2);

    // Not claimed again before it is due.
    deletes.length = 0;
    await processResourceCleanupQueue(testEnv.env);
    expect(deletes).toEqual([]);
  });

  it("retries a due row and marks it failed after the attempt limit", async () => {
    names = { flaky: "creek-flaky000" };
    queue("d1", "flaky", "creek-flaky000");
    respond = () =>
      HttpResponse.json(
        { success: false, errors: [{ code: 7500, message: "busy" }] },
        { status: 503 },
      );

    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      // Make the row due now, as if its backoff had passed.
      testEnv.db.db.exec("UPDATE resource_cleanup_queue SET nextAttemptAt = NULL");
      await processResourceCleanupQueue(testEnv.env);
      expect(row("flaky").attempts).toBe(i);
      expect(row("flaky").status).toBe(i < MAX_ATTEMPTS ? "pending" : "failed");
    }
    expect(deletes).toHaveLength(MAX_ATTEMPTS);
  });

  it("reclaims a row stranded in cleaning by an interrupted run", async () => {
    names = { stuck: "creek-stuck000", legacy: "creek-legacy00" };
    queue("d1", "stuck", "creek-stuck000");
    queue("d1", "legacy", "creek-legacy00");
    // One claimed 20 minutes ago, one claimed before claims carried a time.
    testEnv.db.db.exec(
      `UPDATE resource_cleanup_queue SET status = 'cleaning', attempts = 1, claimedAt = ${nowSec() - 20 * 60} WHERE cfResourceId = 'stuck'`,
    );
    testEnv.db.db.exec(
      "UPDATE resource_cleanup_queue SET status = 'cleaning', claimedAt = NULL WHERE cfResourceId = 'legacy'",
    );

    await processResourceCleanupQueue(testEnv.env);

    expect(statuses()).toEqual(["stuck:done", "legacy:done"]);
    expect(row("stuck").attempts).toBe(2);
  });

  it("leaves a row another run claimed recently alone", async () => {
    names = { busy: "creek-busy0000" };
    queue("d1", "busy", "creek-busy0000");
    testEnv.db.db.exec(
      `UPDATE resource_cleanup_queue SET status = 'cleaning', attempts = 1, claimedAt = ${nowSec() - 60}`,
    );

    await processResourceCleanupQueue(testEnv.env);

    expect(deletes).toEqual([]);
    expect(row("busy").status).toBe("cleaning");
  });

  it("doesn't record an outcome once another run has taken the row over", async () => {
    names = { taken: "creek-taken000" };
    queue("d1", "taken", "creek-taken000");
    respond = () => {
      // While this run's delete is in flight, its claim expires and another
      // run reclaims the row.
      testEnv.db.db.exec("UPDATE resource_cleanup_queue SET claimedAt = claimedAt + 1000");
      return HttpResponse.json({ success: true, result: {}, errors: [] });
    };

    await processResourceCleanupQueue(testEnv.env);

    expect(row("taken").status).toBe("cleaning");
  });

  it("never deletes a resource a live resource row references", async () => {
    // Re-registered by a live row after it was queued for deletion.
    names = { readopted: "creek-readopt0" };
    queue("d1", "readopted", "creek-readopt0");
    testEnv.db.db.exec(
      `INSERT INTO organization (id, name, slug, createdAt) VALUES ('t-live', 'L', 'l', ${Date.now()})`,
    );
    testEnv.db.db.exec(
      `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
       VALUES ('res-live', 't-live', 'database', 'live', 'readopted', 'd1', 'active', ${Date.now()}, ${Date.now()})`,
    );

    await processResourceCleanupQueue(testEnv.env);

    expect(deletes).toEqual([]);
    expect(row("readopted").status).toBe("cancelled");
  });

  it("a 2xx that reports success: false is a failure, not done", async () => {
    names = { soft: "creek-soft0000" };
    queue("d1", "soft", "creek-soft0000");
    respond = () =>
      HttpResponse.json({
        success: false,
        errors: [{ code: 7500, message: "busy" }],
        result: null,
      });

    expect(await processResourceCleanupQueue(testEnv.env)).toBe(0);

    expect(statuses()).toEqual(["soft:pending"]);
  });

  it("a lookup that answers 2xx with success: false is retried, not refused for good", async () => {
    queue("d1", "flaky-lookup", "creek-flaky000");
    server.use(
      http.get("https://api.cloudflare.com/client/v4/accounts/:acc/d1/database/:id", () =>
        HttpResponse.json({
          success: false,
          errors: [{ code: 7500, message: "busy" }],
          result: null,
        }),
      ),
    );

    await processResourceCleanupQueue(testEnv.env);

    expect(deletes).toEqual([]);
    expect(row("flaky-lookup").status).toBe("pending");
    expect(row("flaky-lookup").attempts).toBe(1);
  });

  it("overlapping runs delete each resource once", async () => {
    names = { "d1-a": "creek-aaaa0000", "d1-b": "creek-bbbb0000" };
    queue("d1", "d1-a", "creek-aaaa0000");
    queue("d1", "d1-b", "creek-bbbb0000");

    // Two scheduled runs that both read the queue before either claims a row.
    const [first, second] = await Promise.all([
      processResourceCleanupQueue(testEnv.env),
      processResourceCleanupQueue(testEnv.env),
    ]);

    expect(deletes.filter((p) => p.endsWith("/d1-a"))).toHaveLength(1);
    expect(deletes.filter((p) => p.endsWith("/d1-b"))).toHaveLength(1);
    expect(first + second).toBe(2);
    expect(statuses()).toEqual(["d1-a:done", "d1-b:done"]);
  });

  it("a custom hostname it can't delete (no zone configured) fails instead of passing as done", async () => {
    queue("custom_hostname", "cfh-1", "app.example.com");
    testEnv.env.CLOUDFLARE_ZONE_ID = undefined as unknown as string;

    await processResourceCleanupQueue(testEnv.env);

    expect(deletes).toEqual([]);
    expect(statuses()).toEqual(["cfh-1:failed"]);
  });
});
