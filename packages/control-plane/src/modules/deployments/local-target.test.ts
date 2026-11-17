import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";
import {
  createLocalTestEnv,
  seedTestData,
  seedProject,
  type LocalTestEnv,
} from "../../local/test-env.js";
import { mountLocalPreview } from "../../local/preview-route.js";
import { localTarget } from "./local-target.js";
import type { DeployAssetsInput } from "./deploy.js";
import type { Env } from "../../types.js";

/**
 * The local development server (src/local/serve.ts) has no edge to deploy to.
 * With DEPLOY_TARGET=local a deploy keeps its files where the server's
 * /preview/:slug/* route serves them, so a local `creek deploy` can be looked
 * at. Before this target existed the deployment turned active with none of its
 * files kept, and the preview answered 404.
 */

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const input = (assets: Record<string, string>) =>
  ({
    clientAssets: Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, bytes(v)])),
  }) as DeployAssetsInput;

function preview(env: Env, path: string) {
  const local = new Hono<{ Bindings: Env }>();
  mountLocalPreview(local);
  return local.request(path, {}, env);
}

describe("localTarget.deploy", () => {
  let t: LocalTestEnv;

  beforeEach(() => {
    t = createLocalTestEnv();
    seedTestData(t);
    seedProject(t, "site", { id: "p" });
    const now = Date.now();
    t.db.db.exec(
      `INSERT INTO deployment (id, projectId, version, status, triggerType, createdAt, updatedAt)
       VALUES ('d1', 'p', 1, 'deploying', 'cli', ${now}, ${now})`,
    );
  });
  afterEach(() => t.cleanup());

  async function stored(key: string): Promise<string | null> {
    const object = await t.env.ASSETS.get(key);
    return object ? await object.text() : null;
  }

  test("keeps each client asset under the deployment's prefix", async () => {
    await localTarget.deploy(
      t.env,
      "site",
      "team",
      "d1",
      input({ "index.html": "<h1>one</h1>", "assets/app.js": "console.log(1)" }),
    );

    expect(await stored("p/d1/index.html")).toBe("<h1>one</h1>");
    expect(await stored("p/d1/assets/app.js")).toBe("console.log(1)");
  });

  // Asset names come from the uploaded bundle. The local bucket turns a key
  // into a file path, so a name that climbs out of the deployment's prefix
  // would write wherever it points.
  test.each([
    ["into another project's deployment", "../../other/dep/index.html"],
    ["out of the bucket", "../../../outside.txt"],
    ["with a backslash separator", "..\\..\\other\\dep\\index.html"],
    ["from a nested segment", "assets/../../../other/dep/index.html"],
    ["as an absolute path", "/etc/creek-escape"],
    ["as a Windows absolute path", "C:\\creek-escape"],
    ["as an empty name", ""],
  ])("refuses an asset name that escapes %s, storing nothing", async (_label, name) => {
    await t.env.ASSETS.put("other/dep/index.html", "<h1>theirs</h1>");

    await expect(
      localTarget.deploy(
        t.env,
        "site",
        "team",
        "d1",
        // A valid asset first: nothing may be stored before the bad name is seen.
        input({ "index.html": "<h1>mine</h1>", [name]: "<h1>overwritten</h1>" }),
      ),
    ).rejects.toThrow(/unsafe asset path/);

    expect(await stored("other/dep/index.html")).toBe("<h1>theirs</h1>");
    expect(await stored("p/d1/index.html")).toBeNull();
    expect(await stored("../outside.txt")).toBeNull();
  });

  test.each(["a..b.js", "..hidden/file.js", "dir/.well-known/x.json", "assets/app.v1.2.js"])(
    "keeps an ordinary name containing dots: %s",
    async (name) => {
      await localTarget.deploy(t.env, "site", "team", "d1", input({ [name]: "ok" }));

      expect(await stored(`p/d1/${name}`)).toBe("ok");
    },
  );

  test("refuses a deployment it cannot place, storing nothing", async () => {
    await expect(
      localTarget.deploy(t.env, "site", "team", "missing", input({ "index.html": "x" })),
    ).rejects.toThrow(/deployment missing not found/);

    expect((await t.env.ASSETS.list()).objects).toEqual([]);
  });
});

/**
 * Through the real routes and deploy job. One account for the whole block
 * (sign-up hashes a password, which is slow); each test deploys to a project
 * of its own.
 */
describe("a deploy through the API", () => {
  let f: Fixture;
  let key: string;

  beforeAll(async () => {
    f = createFixture();
    const owner = await f.signUp("owner@example.com");
    key = await f.legacyKey(owner.cookie);
  });
  afterAll(() => f.cleanup());
  beforeEach(() => {
    f.env.DEPLOY_TARGET = "local";
  });

  async function project(slug: string) {
    const created = await f.call("POST", "/projects", { "x-api-key": key }, { slug });
    expect(created.status).toBe(201);
    const [{ id }] = await f.sql<{ id: string }>("SELECT id FROM project WHERE slug = ?", slug);
    return id;
  }

  /** A CLI deploy of `slug`. Returns the deployment id. */
  async function deploy(slug: string, assets: Record<string, string>): Promise<string> {
    const headers = { "x-api-key": key };
    const res = await f.call("POST", `/projects/${slug}/deployments`, headers, {});
    expect(res.status).toBe(201);
    const { deployment } = (await res.json()) as { deployment: { id: string } };
    const put = await f.call(
      "PUT",
      `/projects/${slug}/deployments/${deployment.id}/bundle`,
      headers,
      {
        assets: Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, btoa(v)])),
        manifest: {
          assets: Object.keys(assets),
          hasWorker: false,
          entrypoint: null,
          renderMode: "spa",
        },
      },
    );
    expect(put.status).toBe(202);
    await f.settle();
    const [row] = await f.sql<{ status: string }>(
      "SELECT status FROM deployment WHERE id = ?",
      deployment.id,
    );
    expect(row.status).toBe("active");
    return deployment.id;
  }

  const body = async (path: string) => (await preview(f.env, path)).text();

  test("the preview serves what was deployed", async () => {
    await project("served");
    await deploy("served", { "index.html": "<h1>first</h1>", "app.css": "h1{}" });

    const index = await preview(f.env, "/preview/served/");
    expect(index.status).toBe(200);
    expect(await index.text()).toBe("<h1>first</h1>");

    const css = await preview(f.env, "/preview/served/app.css");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("h1{}");
  });

  test("a second deploy replaces what the preview serves", async () => {
    await project("twice");
    await deploy("twice", { "index.html": "<h1>first</h1>" });
    await deploy("twice", { "index.html": "<h1>second</h1>" });

    expect(await body("/preview/twice/")).toBe("<h1>second</h1>");
  });

  test("a rollback brings the earlier deployment's files back", async () => {
    await project("back");
    await deploy("back", { "index.html": "<h1>first</h1>" });
    await deploy("back", { "index.html": "<h1>second</h1>" });

    const res = await f.call("POST", "/projects/back/rollback", { "x-api-key": key }, {});
    expect(res.status).toBe(200);
    await f.settle();

    expect(await body("/preview/back/")).toBe("<h1>first</h1>");
  });

  test("staging is still reclaimed: only the served files and the manifest remain", async () => {
    const projectId = await project("tidy");
    const id = await deploy("tidy", { "index.html": "<h1>first</h1>" });

    const keys = (await f.env.ASSETS.list()).objects
      .map((o) => o.key)
      .filter(
        (k) =>
          !k.startsWith("logs/") && (k.startsWith(`${projectId}/`) || k.startsWith("bundles/")),
      )
      .sort();

    expect(keys).toEqual([`${projectId}/${id}/_manifest.json`, `${projectId}/${id}/index.html`]);
  });

  test("one project's preview never serves another's files", async () => {
    await project("mine");
    await project("theirs");
    await deploy("mine", { "index.html": "<h1>mine</h1>" });
    await deploy("theirs", { "index.html": "<h1>theirs</h1>" });

    expect(await body("/preview/mine/")).toBe("<h1>mine</h1>");
    expect(await body("/preview/theirs/")).toBe("<h1>theirs</h1>");
  });

  test("without the local target no files are kept, so the preview has nothing to serve", async () => {
    // The Cloudflare target with no API token is a no-op: this is the state
    // the local server was in, and why it now selects the local target.
    f.env.DEPLOY_TARGET = undefined;
    await project("bare");
    await deploy("bare", { "index.html": "<h1>first</h1>" });

    expect((await preview(f.env, "/preview/bare/")).status).toBe(404);
  });
});
