import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createMockD1,
  createTestEnv,
  createTestApp,
  seedMemberRole,
  TEST_USER,
  TEST_TEAM,
  type MockD1,
} from "../../test-helpers.js";

let db: MockD1;
let env: ReturnType<typeof createTestEnv>;
let app: ReturnType<typeof createTestApp>;

const originalFetch = globalThis.fetch;

beforeEach(() => {
  db = createMockD1();
  env = createTestEnv(db);
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
  seedMemberRole(db);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function send(projectId: string, body: unknown) {
  return app.request(
    `/projects/${projectId}/queue/send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

function patchTriggers(projectId: string, body: unknown) {
  return app.request(
    `/projects/${projectId}/triggers`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("PATCH /projects/:id/triggers", () => {
  test("returns 404 for unknown project", async () => {
    const res = await patchTriggers("unknown", { cron: ["0 0 * * *"] });
    expect(res.status).toBe(404);
  });

  test("rejects empty body", async () => {
    db.seedFirst("SELECT id, slug, triggers FROM project WHERE", ["my-app", "my-app", TEST_TEAM.id], {
      id: "p-1",
      slug: "my-app",
      triggers: null,
    });

    const res = await patchTriggers("my-app", {});
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe("validation");
    expect(json.message).toContain("at least one of");
  });

  test("rejects non-array cron field", async () => {
    db.seedFirst("SELECT id, slug, triggers FROM project WHERE", ["my-app", "my-app", TEST_TEAM.id], {
      id: "p-1",
      slug: "my-app",
      triggers: null,
    });

    const res = await patchTriggers("my-app", { cron: "not-an-array" });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe("validation");
  });

  test("rejects non-boolean queue field", async () => {
    db.seedFirst("SELECT id, slug, triggers FROM project WHERE", ["my-app", "my-app", TEST_TEAM.id], {
      id: "p-1",
      slug: "my-app",
      triggers: null,
    });

    const res = await patchTriggers("my-app", { queue: "yes" });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe("validation");
  });

  test("updates cron schedules and persists to DB", async () => {
    db.seedFirst("SELECT id, slug, triggers FROM project WHERE", ["my-app", "my-app", TEST_TEAM.id], {
      id: "p-1",
      slug: "my-app",
      triggers: '{"cron":["0 0 * * *"],"queue":false}',
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: {} })),
    );

    const res = await patchTriggers("my-app", { cron: ["*/15 * * * *", "0 0 * * *"] });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.cron).toEqual(["*/15 * * * *", "0 0 * * *"]);
    expect(json.queue).toBe(false);
    expect(json.queueRequiresRedeploy).toBe(false);

    // Verify CF API call
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toContain(`/scripts/my-app-${TEST_TEAM.slug}/schedules`);
    expect(fetchCall[1].method).toBe("PUT");
    const body = JSON.parse(fetchCall[1].body);
    expect(body.schedules).toEqual([{ cron: "*/15 * * * *" }, { cron: "0 0 * * *" }]);

    // Verify DB update
    const writes = db.getExecuted().filter((q) => q.sql.includes("UPDATE project"));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0].args[0]).toContain('"cron":["*/15 * * * *","0 0 * * *"]');
    expect(writes[0].args[0]).toContain('"queue":false');

    // Verify audit log was written
    const auditWrites = db.getExecuted().filter((q) => q.sql.includes("audit_log"));
    expect(auditWrites.length).toBeGreaterThan(0);
  });

  test("toggling queue does NOT call CF API and signals queueRequiresRedeploy", async () => {
    db.seedFirst("SELECT id, slug, triggers FROM project WHERE", ["my-app", "my-app", TEST_TEAM.id], {
      id: "p-1",
      slug: "my-app",
      triggers: '{"cron":[],"queue":false}',
    });

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: {} })),
    );
    globalThis.fetch = fetchSpy;

    const res = await patchTriggers("my-app", { queue: true });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.queue).toBe(true);
    expect(json.queueRequiresRedeploy).toBe(true);

    // Should NOT have called CF schedules API for queue-only update
    expect(fetchSpy).not.toHaveBeenCalled();

    // DB should have the new queue value
    const writes = db.getExecuted().filter((q) => q.sql.includes("UPDATE project"));
    expect(writes[0].args[0]).toContain('"queue":true');
  });

  test("toggling queue to same value does not flag queueRequiresRedeploy", async () => {
    db.seedFirst("SELECT id, slug, triggers FROM project WHERE", ["my-app", "my-app", TEST_TEAM.id], {
      id: "p-1",
      slug: "my-app",
      triggers: '{"cron":[],"queue":true}',
    });

    const res = await patchTriggers("my-app", { queue: true });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.queueRequiresRedeploy).toBe(false);
  });

  test("can update both cron and queue in one request", async () => {
    db.seedFirst("SELECT id, slug, triggers FROM project WHERE", ["my-app", "my-app", TEST_TEAM.id], {
      id: "p-1",
      slug: "my-app",
      triggers: '{"cron":[],"queue":false}',
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: {} })),
    );

    const res = await patchTriggers("my-app", { cron: ["0 * * * *"], queue: true });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.cron).toEqual(["0 * * * *"]);
    expect(json.queue).toBe(true);
    expect(json.queueRequiresRedeploy).toBe(true);
  });

  test("returns 500 when CF API fails", async () => {
    db.seedFirst("SELECT id, slug, triggers FROM project WHERE", ["my-app", "my-app", TEST_TEAM.id], {
      id: "p-1",
      slug: "my-app",
      triggers: null,
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ message: "script not found" }] })),
    );

    const res = await patchTriggers("my-app", { cron: ["* * * * *"] });
    expect(res.status).toBe(500);
    const json = await res.json() as any;
    expect(json.error).toBe("update_failed");
  });
});

describe("POST /projects/:id/queue/send", () => {
  test("returns 404 for unknown project", async () => {
    const res = await send("unknown", { message: "hi" });
    expect(res.status).toBe(404);
  });

  test("returns 400 when project has no queue provisioned", async () => {
    db.seedFirst("SELECT id FROM project WHERE", ["my-app", "my-app", TEST_TEAM.id], { id: "p-1" });
    db.seedFirst(
      "SELECT cfResourceId FROM project_resource WHERE projectId = ? AND resourceType = ? AND status",
      ["p-1", "queue"],
      null,
    );

    const res = await send("my-app", { message: "hello" });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe("queue_not_provisioned");
  });

  test("returns 400 when message field is missing", async () => {
    db.seedFirst("SELECT id FROM project WHERE", ["my-app", "my-app", TEST_TEAM.id], { id: "p-1" });
    db.seedFirst(
      "SELECT cfResourceId FROM project_resource WHERE projectId = ? AND resourceType = ? AND status",
      ["p-1", "queue"],
      { cfResourceId: "queue-id-123" },
    );

    const res = await send("my-app", {});
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe("validation");
  });

  test("sends message to CF Queues API on success", async () => {
    db.seedFirst("SELECT id FROM project WHERE", ["my-app", "my-app", TEST_TEAM.id], { id: "p-1" });
    db.seedFirst(
      "SELECT cfResourceId FROM project_resource WHERE projectId = ? AND resourceType = ? AND status",
      ["p-1", "queue"],
      { cfResourceId: "queue-id-123" },
    );

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: {} })),
    );
    globalThis.fetch = fetchSpy;

    const res = await send("my-app", { message: { type: "process", id: "42" } });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.queueId).toBe("queue-id-123");

    // Verify CF API call
    const fetchCall = fetchSpy.mock.calls[0];
    expect(fetchCall[0]).toContain("/queues/queue-id-123/messages");
    const body = JSON.parse(fetchCall[1].body);
    expect(body.body).toBe(JSON.stringify({ type: "process", id: "42" }));
    expect(body.content_type).toBe("json");
  });

  test("sends string message as text content type", async () => {
    db.seedFirst("SELECT id FROM project WHERE", ["my-app", "my-app", TEST_TEAM.id], { id: "p-1" });
    db.seedFirst(
      "SELECT cfResourceId FROM project_resource WHERE projectId = ? AND resourceType = ? AND status",
      ["p-1", "queue"],
      { cfResourceId: "queue-id-123" },
    );

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: {} })),
    );
    globalThis.fetch = fetchSpy;

    const res = await send("my-app", { message: "plain string" });
    expect(res.status).toBe(200);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.body).toBe("plain string");
    expect(body.content_type).toBe("text");
  });

  test("returns 500 when CF API fails", async () => {
    db.seedFirst("SELECT id FROM project WHERE", ["my-app", "my-app", TEST_TEAM.id], { id: "p-1" });
    db.seedFirst(
      "SELECT cfResourceId FROM project_resource WHERE projectId = ? AND resourceType = ? AND status",
      ["p-1", "queue"],
      { cfResourceId: "queue-id-123" },
    );

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ message: "queue not found" }] })),
    );

    const res = await send("my-app", { message: "hi" });
    expect(res.status).toBe(500);
    const json = await res.json() as any;
    expect(json.error).toBe("send_failed");
  });
});
