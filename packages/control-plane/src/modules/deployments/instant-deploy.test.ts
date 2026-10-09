import { describe, it, expect, afterEach } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";

describe("POST /instant-deploy slug validation", () => {
  let f: Fixture;
  afterEach(() => f.cleanup());

  it("refuses a slug containing -git-, which names another project's branch deploys", async () => {
    f = createFixture();
    const owner = await f.signUp("owner@example.com");
    const key = await f.legacyKey(owner.cookie);
    for (const slug of ["app-git-x", "a-git-b-c"]) {
      const res = await f.call(
        "POST",
        "/instant-deploy",
        { "x-api-key": key },
        { slug, files: { "index.html": "<h1>x</h1>" } },
      );
      expect(res.status, slug).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain("-git-");
    }
    expect(await f.sql("SELECT id FROM project")).toEqual([]);
  });
});
