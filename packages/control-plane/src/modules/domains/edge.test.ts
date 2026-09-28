import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createLocalTestEnv, seedTestData, type LocalTestEnv } from "../../local/test-env.js";
import { TEST_TEAM } from "../../test-helpers.js";
import { linkUnregisteredDomains } from "./edge.js";

let testEnv: LocalTestEnv;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  testEnv = createLocalTestEnv();
  seedTestData(testEnv);
  const now = Date.now();
  testEnv.db.db.exec(
    `INSERT OR IGNORE INTO project (id, slug, organizationId, productionBranch, createdAt, updatedAt)
     VALUES ('proj-1', 'my-app', '${TEST_TEAM.id}', 'main', ${now}, ${now})`,
  );
});

afterEach(() => {
  testEnv.cleanup();
  globalThis.fetch = originalFetch;
});

function insertDomain(id: string, hostname: string, status: string, cfId: string | null = null) {
  testEnv.db.db
    .prepare(
      `INSERT INTO custom_domain (id, projectId, hostname, status, cfCustomHostnameId, createdAt)
       VALUES (?, 'proj-1', ?, ?, ?, ?)`,
    )
    .run(id, hostname, status, cfId, Math.floor(Date.now() / 1000));
}

function row(id: string) {
  return testEnv.db.db
    .prepare("SELECT status, cfCustomHostnameId FROM custom_domain WHERE id = ?")
    .get(id) as { status: string; cfCustomHostnameId: string | null };
}

describe("linkUnregisteredDomains (the sync cron's repair pass)", () => {
  test("registers pending domains with no edge id, and skips the ones the edge rejects", async () => {
    insertDomain("ok", "ok.example.com", "pending");
    insertDomain("live", "live.example.com", "pending");
    insertDomain("down", "down.example.com", "pending");
    insertDomain("linked", "linked.example.com", "pending", "cf-linked");
    insertDomain("gone", "gone.example.com", "failed");

    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (init?.method === "POST" && body.hostname !== "down.example.com") {
        const status = body.hostname === "live.example.com" ? "active" : "pending";
        return new Response(
          JSON.stringify({
            success: true,
            result: { id: `cf-${body.hostname.split(".")[0]}`, hostname: body.hostname, status },
          }),
        );
      }
      return new Response(
        JSON.stringify({ success: false, errors: [{ code: 1000, message: "no" }] }),
      );
    }) as any;

    const linked = await linkUnregisteredDomains(testEnv.env);

    expect(linked).toBe(2);
    expect(row("ok")).toEqual({ status: "pending", cfCustomHostnameId: "cf-ok" });
    expect(row("live")).toEqual({ status: "active", cfCustomHostnameId: "cf-live" });
    expect(row("down")).toEqual({ status: "pending", cfCustomHostnameId: null });
    expect(row("linked")).toEqual({ status: "pending", cfCustomHostnameId: "cf-linked" });
    expect(row("gone")).toEqual({ status: "failed", cfCustomHostnameId: null });
  });

  test("does nothing when no edge zone is configured", async () => {
    insertDomain("ok", "ok.example.com", "pending");
    globalThis.fetch = vi.fn() as any;

    const linked = await linkUnregisteredDomains({ ...testEnv.env, CLOUDFLARE_ZONE_ID: "" });

    expect(linked).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
