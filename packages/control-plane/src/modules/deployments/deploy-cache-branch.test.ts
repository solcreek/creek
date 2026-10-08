import { describe, it, expect, afterEach, vi } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";

// Capture what the build-cache deploy hands to the deploy target.
const deploy = vi.fn(async () => {});
vi.mock("./target.js", () => ({ resolveDeployTarget: () => ({ deploy }) }));

/**
 * POST /projects/:id/deployments with a commitSha that the remote builder
 * has cached deploys straight from the cache. That deploy must use the
 * project's production branch — the same one the route's scope check used —
 * or a deploy:preview key could name a branch the check calls preview but
 * the deploy calls production.
 */
describe("build-cache deploy and the production branch", () => {
  let f: Fixture;
  afterEach(() => {
    deploy.mockClear();
    f.cleanup();
  });

  async function setup(productionBranch: string) {
    f = createFixture();
    const owner = await f.signUp("owner@example.com");
    const now = Date.now();
    await f.sql(
      `INSERT INTO project (id, slug, organizationId, productionBranch, githubRepo, createdAt, updatedAt)
       VALUES ('proj-site', 'site', ?, ?, 'acme/site', ?, ?)`,
      owner.orgId,
      productionBranch,
      now,
      now,
    );
    const bundle = JSON.stringify({
      assets: { "index.html": btoa("<h1>cached</h1>") },
      manifest: { assets: ["index.html"], hasWorker: false, entrypoint: null, renderMode: "spa" },
    });
    for (const branch of ["main", "release"]) {
      await f.env.BUILD_STATUS.put(
        `bundlecache:https://github.com/acme/site:${branch}:abc123`,
        bundle,
      );
    }
    return owner;
  }

  it("deploys a cache hit on a non-production branch as a branch deploy", async () => {
    const owner = await setup("release");
    const key = await f.scopedKey(owner.userId, owner.orgId, ["deploy:preview"]);
    const res = await f.call(
      "POST",
      "/projects/site/deployments",
      { "x-api-key": key },
      { branch: "main", commitSha: "abc123" },
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { cacheHit: boolean }).cacheHit).toBe(true);
    await f.settle();
    expect(deploy).toHaveBeenCalledTimes(1);
    const [, , , , , branch, productionBranch] = deploy.mock.calls[0] as unknown[];
    expect([branch, productionBranch]).toEqual(["main", "release"]);
  });

  it("looks up the production branch's build when no branch is given", async () => {
    const owner = await setup("release");
    // Only main's build is cached for this commit: a branchless (production)
    // request must not deploy it.
    await f.env.BUILD_STATUS.delete(`bundlecache:https://github.com/acme/site:release:abc123`);
    const key = await f.scopedKey(owner.userId, owner.orgId, ["deploy:production"]);
    const miss = await f.call(
      "POST",
      "/projects/site/deployments",
      { "x-api-key": key },
      { commitSha: "abc123" },
    );
    expect(miss.status).toBe(201);
    expect(((await miss.json()) as { cacheHit: boolean }).cacheHit).toBe(false);
    await f.settle();
    expect(deploy).not.toHaveBeenCalled();

    // With release's build cached, the same request deploys it as production.
    const mainBuild = await f.env.BUILD_STATUS.get(
      `bundlecache:https://github.com/acme/site:main:abc123`,
    );
    await f.env.BUILD_STATUS.put(
      `bundlecache:https://github.com/acme/site:release:abc123`,
      mainBuild!,
    );
    const hit = await f.call(
      "POST",
      "/projects/site/deployments",
      { "x-api-key": key },
      { commitSha: "abc123" },
    );
    expect(((await hit.json()) as { cacheHit: boolean }).cacheHit).toBe(true);
    await f.settle();
    const [, , , , , branch, productionBranch] = deploy.mock.calls[0] as unknown[];
    expect([branch, productionBranch]).toEqual([undefined, "release"]);
  });

  it("refuses a cache hit on the production branch to deploy:preview before deploying", async () => {
    const owner = await setup("release");
    const key = await f.scopedKey(owner.userId, owner.orgId, ["deploy:preview"]);
    const res = await f.call(
      "POST",
      "/projects/site/deployments",
      { "x-api-key": key },
      { branch: "release", commitSha: "abc123" },
    );
    expect(res.status).toBe(403);
    await f.settle();
    expect(deploy).not.toHaveBeenCalled();
  });
});
