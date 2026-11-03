import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import { deleteStagedBundle } from "./deploy-job.js";

let t: LocalTestEnv;
beforeEach(() => {
  t = createLocalTestEnv();
});
afterEach(() => {
  vi.restoreAllMocks();
  t.cleanup();
});

async function stage(id: string, files: number) {
  await t.env.ASSETS.put(`bundles/${id}.json`, "{}");
  for (let i = 0; i < files; i++) {
    await t.env.ASSETS.put(`bundles/${id}-server/_next/static/m${i}.js`, "x");
  }
}
const count = async (prefix: string) => {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await t.env.ASSETS.list({ prefix, cursor });
    n += page.objects.length;
    cursor = page.truncated ? (page as { cursor?: string }).cursor : undefined;
  } while (cursor);
  return n;
};

describe("deleteStagedBundle", () => {
  it("deletes every staged server file across pages, one bulk delete per page", async () => {
    await stage("dep", 2500);
    await stage("other", 3);
    const del = vi.spyOn(t.env.ASSETS, "delete");

    await deleteStagedBundle(t.env, "dep");

    expect(await count("bundles/dep-server/")).toBe(0);
    expect(await t.env.ASSETS.get("bundles/dep.json")).toBeNull();
    // The bundle JSON + 3 pages of server files, not 2501 single deletes.
    expect(del).toHaveBeenCalledTimes(4);
    expect(del.mock.calls.slice(1).map((c) => (c[0] as string[]).length)).toEqual([
      1000, 1000, 500,
    ]);
    // Another deployment's staging is untouched.
    expect(await count("bundles/other-server/")).toBe(3);
    expect(await t.env.ASSETS.get("bundles/other.json")).not.toBeNull();
  });

  it("deletes only the bundle JSON when no server files were staged", async () => {
    await t.env.ASSETS.put("bundles/spa.json", "{}");
    await deleteStagedBundle(t.env, "spa");
    expect(await t.env.ASSETS.get("bundles/spa.json")).toBeNull();
  });

  it("logs a failure instead of throwing, and still deletes the bundle JSON", async () => {
    await stage("dep", 2);
    vi.spyOn(t.env.ASSETS, "list").mockRejectedValue(new Error("Too many subrequests."));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(deleteStagedBundle(t.env, "dep")).resolves.toBeUndefined();
    expect(await t.env.ASSETS.get("bundles/dep.json")).toBeNull();
    expect(err).toHaveBeenCalledWith(
      "[staging] could not reclaim the server files of dep: Too many subrequests.",
    );
  });
});
