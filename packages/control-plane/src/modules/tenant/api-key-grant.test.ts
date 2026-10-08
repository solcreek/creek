import { describe, it, expect, afterEach, vi } from "vitest";
import { createFixture, type Fixture } from "./scoped-key-fixture.js";
import * as grantModule from "./api-key-grant.js";

/**
 * Defense-in-depth branches that Better Auth's own checks normally make
 * unreachable: they must still fail closed if those checks ever change.
 */
describe("loadApiKeyGrant", () => {
  let f: Fixture;
  afterEach(() => f.cleanup());

  it("does not treat another user's apikey row as this session's key", async () => {
    f = createFixture();
    const a = await f.signUp("a@example.com");
    const b = await f.signUp("b@example.com");
    await f.scopedKey(a.userId, a.orgId, ["project:read"]);
    const [row] = await f.sql<{ id: string }>("SELECT id FROM apikey");
    expect(await grantModule.loadApiKeyGrant(f.t.env.DB, row.id, a.userId)).toMatchObject({
      kind: "scoped",
    });
    expect(await grantModule.loadApiKeyGrant(f.t.env.DB, row.id, b.userId)).toBeNull();
    expect(await grantModule.loadApiKeyGrant(f.t.env.DB, "no-such-id", a.userId)).toBeNull();
  });
});

describe("tenantMiddleware with an API key but no apikey row behind the session", () => {
  let f: Fixture;
  afterEach(() => {
    vi.restoreAllMocks();
    f.cleanup();
  });

  it("refuses with 401 instead of falling back to the user's full access", async () => {
    f = createFixture();
    const owner = await f.signUp("owner@example.com");
    const key = await f.legacyKey(owner.cookie);
    expect((await f.call("GET", "/projects", { "x-api-key": key })).status).toBe(200);

    vi.spyOn(grantModule, "loadApiKeyGrant").mockResolvedValue(null);
    expect((await f.call("GET", "/projects", { "x-api-key": key })).status).toBe(401);
    // A cookie session has no apikey row and is unaffected.
    expect((await f.call("GET", "/projects", { cookie: owner.cookie })).status).toBe(200);
  });

  it("looks up a grant only for key requests, not for the dashboard's cookie", async () => {
    f = createFixture();
    const owner = await f.signUp("owner@example.com");
    const key = await f.legacyKey(owner.cookie);
    const lookup = vi.spyOn(grantModule, "loadApiKeyGrant");

    expect((await f.call("GET", "/projects", { cookie: owner.cookie })).status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();

    expect(
      (await f.call("GET", "/projects", { "x-api-key": key, cookie: owner.cookie })).status,
    ).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
