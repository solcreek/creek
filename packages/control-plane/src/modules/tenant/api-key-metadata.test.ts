import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFixture, type Fixture } from "./scoped-key-fixture.js";

/**
 * API key metadata is server-only: a signed-in session cannot set it on
 * Better Auth's create endpoint or change it on update, however the request
 * is spelled. The dashboard's own calls (no metadata) keep working.
 */

const ORIGIN = "http://localhost:5173";

describe("API key metadata from a session", () => {
  let f: Fixture;
  let cookie: string;
  beforeEach(async () => {
    f = createFixture();
    ({ cookie } = await f.signUp("owner@example.com"));
  });
  afterEach(() => f.cleanup());

  const session = (extra: Record<string, string> = {}) => ({ cookie, origin: ORIGIN, ...extra });
  const json = (body: unknown) => JSON.stringify(body);
  const keys = () =>
    f.sql<{ id: string; name: string; metadata: string | null }>(
      "SELECT id, name, metadata FROM apikey",
    );

  async function createKey(): Promise<string> {
    const res = await f.callRaw(
      "POST",
      "/api/auth/api-key/create",
      session({ "content-type": "application/json" }),
      json({ name: "dash" }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }).id;
  }

  it("cannot set metadata on create, in any spelling", async () => {
    const big = { blob: "x".repeat(10_000) };
    const cases: [string, Record<string, string>, BodyInit][] = [
      [
        "/api/auth/api-key/create",
        { "content-type": "application/json" },
        json({ name: "a", metadata: big }),
      ],
      [
        "/api/auth/api-key/create",
        { "content-type": "application/json" },
        json({ name: "a", metadata: null }),
      ],
      [
        "/api/auth/api-key/create",
        { "content-type": "application/json; charset=utf-8" },
        json({ name: "a", metadata: big }),
      ],
      [
        "/api/auth/api-key/create",
        { "content-type": "Application/JSON" },
        json({ name: "a", metadata: big }),
      ],
      [
        "/api/auth/api-key/create",
        { "content-type": "application/json" },
        '{"name":"a","met\\u0061data":{"x":1}}',
      ],
      [
        "/api/auth/api-key/create",
        { "content-type": "application/json" },
        '{"name":"a","metadata":{"x":1},"name":"b"}',
      ],
      [
        "/api/auth/api-key/create",
        { "content-type": "application/vnd.api+json" },
        json({ name: "a", metadata: big }),
      ],
      [
        "/api/auth/api-key/create",
        { "content-type": "text/plain" },
        json({ name: "a", metadata: big }),
      ],
      ["/api/auth/api-key/create", {}, json({ name: "a", metadata: big })],
      [
        "/api/auth/api-key/create",
        { "content-type": "application/x-www-form-urlencoded" },
        "name=a&metadata=x",
      ],
      [
        "/api/auth/api-key/create/",
        { "content-type": "application/json" },
        json({ name: "a", metadata: big }),
      ],
      [
        "/api/auth/api%2Dkey/create",
        { "content-type": "application/json" },
        json({ name: "a", metadata: big }),
      ],
      [
        "/api/auth/API-KEY/create",
        { "content-type": "application/json" },
        json({ name: "a", metadata: big }),
      ],
      [
        "/api/auth//api-key/create",
        { "content-type": "application/json" },
        json({ name: "a", metadata: big }),
      ],
    ];
    for (const [path, headers, body] of cases) {
      const res = await f.callRaw("POST", path, session(headers), body);
      expect(
        res.status,
        `${path} ${JSON.stringify(headers)} ${String(body).slice(0, 60)}`,
      ).toBeGreaterThanOrEqual(400);
    }
    const form = new FormData();
    form.set("name", "a");
    form.set("metadata", "x");
    expect(
      (await f.callRaw("POST", "/api/auth/api-key/create", session(), form)).status,
    ).toBeGreaterThanOrEqual(400);

    expect(await keys()).toEqual([]);
  });

  it("answers metadata_not_allowed for the plain JSON case", async () => {
    const res = await f.callRaw(
      "POST",
      "/api/auth/api-key/create",
      session({ "content-type": "application/json" }),
      json({ name: "a", metadata: { x: 1 } }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("metadata_not_allowed");
    expect(await keys()).toEqual([]);
  });

  it("cannot change metadata on update", async () => {
    const id = await createKey();
    for (const [headers, body] of [
      [{ "content-type": "application/json" }, json({ keyId: id, metadata: { x: 1 } })],
      [{ "content-type": "application/json" }, json({ keyId: id, name: "n", metadata: null })],
      [{ "content-type": "text/plain" }, json({ keyId: id, metadata: { x: 1 } })],
    ] as [Record<string, string>, string][]) {
      const res = await f.callRaw("POST", "/api/auth/api-key/update", session(headers), body);
      expect(res.status, body).toBeGreaterThanOrEqual(400);
    }
    const [row] = await keys();
    // Better Auth stores "no metadata" as the JSON text null.
    expect(row.name).toBe("dash");
    expect([null, "null"]).toContain(row.metadata);
  });

  it("keeps the dashboard's create, update and list working without metadata", async () => {
    const id = await createKey();
    const update = await f.callRaw(
      "POST",
      "/api/auth/api-key/update",
      session({ "content-type": "application/json" }),
      json({ keyId: id, name: "renamed" }),
    );
    expect(update.status).toBe(200);
    const [row] = await keys();
    expect(row).toMatchObject({ id, name: "renamed" });
    expect([null, "null"]).toContain(row.metadata);
    const list = await f.call("GET", "/api/auth/api-key/list", session());
    expect(list.status).toBe(200);
    const del = await f.callRaw(
      "POST",
      "/api/auth/api-key/delete",
      session({ "content-type": "application/json" }),
      json({ keyId: id }),
    );
    expect(del.status).toBe(200);
    expect(await keys()).toEqual([]);
  });
});
