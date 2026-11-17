import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalR2Bucket } from "./r2-adapter.js";

/**
 * LocalR2Bucket backs the local server's ASSETS binding and turns a key into
 * a file path. A key must never name a file outside the bucket's directory:
 * the server stores names that came from an uploaded bundle.
 *
 * The bucket's other tests (r2-adapter.test.ts) run under `bun test`, which
 * the CI gate does not invoke. This guard is security-relevant, so it is
 * pinned here, where vitest and CI run it.
 */
describe("LocalR2Bucket keeps every key inside its directory", () => {
  let parent: string;
  let root: string;
  let bucket: LocalR2Bucket;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "creek-r2-containment-"));
    root = join(parent, "assets");
    bucket = new LocalR2Bucket(root);
  });
  afterEach(() => rmSync(parent, { recursive: true, force: true }));

  test.each([
    "../outside.txt",
    "a/../../outside.txt",
    "p/d1/../../../outside.txt",
    "/../outside.txt",
  ])("refuses to write %s", async (key) => {
    await expect(bucket.put(key, "x")).rejects.toThrow(/escapes the bucket/);

    expect(existsSync(join(parent, "outside.txt"))).toBe(false);
  });

  test("refuses to read a file outside it", async () => {
    await new LocalR2Bucket(join(parent, "other")).put("secret.txt", "theirs");

    await expect(bucket.get("../other/secret.txt")).rejects.toThrow(/escapes the bucket/);
    await expect(bucket.head("../other/secret.txt")).rejects.toThrow(/escapes the bucket/);
  });

  test("does not delete a file outside it", async () => {
    const other = new LocalR2Bucket(join(parent, "other"));
    await other.put("keep.txt", "theirs");

    await bucket.delete("../other/keep.txt");
    await bucket.delete(["ok.txt", "../other/keep.txt"]);

    expect(await (await other.get("keep.txt"))!.text()).toBe("theirs");
  });

  test("is not fooled by a sibling directory that shares its name as a prefix", async () => {
    // "<root>-evil" starts with "<root>" as a string, but is not inside it.
    await expect(bucket.put("../assets-evil/x.txt", "x")).rejects.toThrow(/escapes the bucket/);

    expect(existsSync(join(parent, "assets-evil"))).toBe(false);
  });

  test("keeps ordinary keys, including ones with dots and a .. that stays inside", async () => {
    await bucket.put("p/d1/assets/app.v1..2.js", "one");
    await bucket.put("p/d1/sub/../index.html", "two");

    expect(await (await bucket.get("p/d1/assets/app.v1..2.js"))!.text()).toBe("one");
    expect(await (await bucket.get("p/d1/index.html"))!.text()).toBe("two");
  });
});
