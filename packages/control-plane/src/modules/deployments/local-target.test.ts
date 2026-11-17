import { describe, test, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";
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

let f: Fixture;
afterEach(() => f.cleanup());

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const input = (assets: Record<string, string>) =>
  ({
    clientAssets: Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, bytes(v)])),
  }) as DeployAssetsInput;

async function stored(key: string): Promise<string | null> {
  const object = await f.env.ASSETS.get(key);
  return object ? await object.text() : null;
}

function preview(path: string) {
  const local = new Hono<{ Bindings: Env }>();
  mountLocalPreview(local);
  return local.request(path, {}, f.env);
}

describe("localTarget.deploy", () => {
  async function seed() {
    f = createFixture();
    const owner = await f.signUp("owner@example.com");
    const now = Date.now();
    await f.sql(
      "INSERT INTO project (id, slug, organizationId, createdAt, updatedAt) VALUES ('p', 'site', ?, ?, ?)",
      owner.orgId,
      now,
      now,
    );
    await f.sql(
      `INSERT INTO deployment (id, projectId, version, status, triggerType, createdAt, updatedAt)
       VALUES ('d1', 'p', 1, 'deploying', 'cli', ?, ?)`,
      now,
      now,
    );
  }

  test("keeps each client asset under the deployment's prefix", async () => {
    await seed();

    await localTarget.deploy(
      f.env,
      "site",
      "team",
      "d1",
      input({ "index.html": "<h1>one</h1>", "assets/app.js": "console.log(1)" }),
    );

    expect(await stored("p/d1/index.html")).toBe("<h1>one</h1>");
    expect(await stored("p/d1/assets/app.js")).toBe("console.log(1)");
  });

  test("refuses a deployment it cannot place, storing nothing", async () => {
    await seed();

    await expect(
      localTarget.deploy(f.env, "site", "team", "missing", input({ "index.html": "x" })),
    ).rejects.toThrow(/deployment missing not found/);

    expect((await f.env.ASSETS.list()).objects).toEqual([]);
  });
});

describe("a deploy on the local server (DEPLOY_TARGET=local)", () => {
  async function setup() {
    f = createFixture();
    f.env.DEPLOY_TARGET = "local";
    const owner = await f.signUp("owner@example.com");
    const key = await f.legacyKey(owner.cookie);
    const created = await f.call("POST", "/projects", { "x-api-key": key }, { slug: "site" });
    expect(created.status).toBe(201);
    return key;
  }

  /** A CLI deploy, through the real routes and deploy job. Returns the deployment id. */
  async function deploy(key: string, assets: Record<string, string>): Promise<string> {
    const headers = { "x-api-key": key };
    const res = await f.call("POST", "/projects/site/deployments", headers, {});
    expect(res.status).toBe(201);
    const { deployment } = (await res.json()) as { deployment: { id: string } };
    const put = await f.call("PUT", `/projects/site/deployments/${deployment.id}/bundle`, headers, {
      assets: Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, btoa(v)])),
      manifest: {
        assets: Object.keys(assets),
        hasWorker: false,
        entrypoint: null,
        renderMode: "spa",
      },
    });
    expect(put.status).toBe(202);
    await f.settle();
    const [row] = await f.sql<{ status: string }>(
      "SELECT status FROM deployment WHERE id = ?",
      deployment.id,
    );
    expect(row.status).toBe("active");
    return deployment.id;
  }

  test("the preview serves what was deployed", async () => {
    const key = await setup();
    await deploy(key, { "index.html": "<h1>first</h1>", "app.css": "h1{}" });

    const index = await preview("/preview/site/");
    expect(index.status).toBe(200);
    expect(await index.text()).toBe("<h1>first</h1>");

    const css = await preview("/preview/site/app.css");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("h1{}");
  });

  test("a second deploy replaces what the preview serves", async () => {
    const key = await setup();
    await deploy(key, { "index.html": "<h1>first</h1>" });
    await deploy(key, { "index.html": "<h1>second</h1>" });

    expect(await (await preview("/preview/site/")).text()).toBe("<h1>second</h1>");
  });

  test("a rollback brings the earlier deployment's files back", async () => {
    const key = await setup();
    await deploy(key, { "index.html": "<h1>first</h1>" });
    await deploy(key, { "index.html": "<h1>second</h1>" });

    const res = await f.call("POST", "/projects/site/rollback", { "x-api-key": key }, {});
    expect(res.status).toBe(200);
    await f.settle();

    expect(await (await preview("/preview/site/")).text()).toBe("<h1>first</h1>");
  });

  test("staging is still reclaimed: only the served files and the manifest remain", async () => {
    const key = await setup();
    const id = await deploy(key, { "index.html": "<h1>first</h1>" });

    const keys = (await f.env.ASSETS.list()).objects.map((o) => o.key).sort();
    const [{ id: projectId }] = await f.sql<{ id: string }>("SELECT id FROM project");

    expect(keys).toEqual([`${projectId}/${id}/_manifest.json`, `${projectId}/${id}/index.html`]);
  });
});

describe("a deploy without the local target", () => {
  test("keeps no files, so the preview has nothing to serve", async () => {
    // The Cloudflare target with no API token is a no-op: this is the state
    // the local server was in, and why it now selects the local target.
    f = createFixture();
    const owner = await f.signUp("owner@example.com");
    const key = await f.legacyKey(owner.cookie);
    const headers = { "x-api-key": key };
    await f.call("POST", "/projects", headers, { slug: "site" });
    const res = await f.call("POST", "/projects/site/deployments", headers, {});
    const { deployment } = (await res.json()) as { deployment: { id: string } };
    await f.call("PUT", `/projects/site/deployments/${deployment.id}/bundle`, headers, {
      assets: { "index.html": btoa("<h1>first</h1>") },
      manifest: { assets: ["index.html"], hasWorker: false, entrypoint: null, renderMode: "spa" },
    });
    await f.settle();

    expect((await preview("/preview/site/")).status).toBe(404);
  });
});
