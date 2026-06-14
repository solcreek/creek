import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  createD1Database,
  findExistingCFResource,
  getD1Database,
  provisionCFResource,
} from "./cloudflare";
import type { Env } from "../../types.js";

// MSW mocks the Cloudflare REST API so we can assert what the resource
// provisioner sends and how it parses responses — without real CF or
// credentials. All identifiers below are fabricated.
const env = {
  CLOUDFLARE_API_TOKEN: "test-token",
  CLOUDFLARE_ACCOUNT_ID: "test-account",
} as unknown as Env;

const CF = "https://api.cloudflare.com/client/v4/accounts/:acc";
let lastBody: unknown = null;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  lastBody = null;
  server.resetHandlers();
});
afterAll(() => server.close());

function ok(result: unknown) {
  return HttpResponse.json({ success: true, result, errors: [] });
}

describe("resource provisioning (CF REST via MSW)", () => {
  it("createD1Database POSTs the name and returns the new uuid", async () => {
    server.use(
      http.post(`${CF}/d1/database`, async ({ request }) => {
        lastBody = await request.json();
        return ok({ uuid: "d1-uuid-fake", name: "myapp-db" });
      }),
    );
    const id = await createD1Database(env, "myapp-db");
    expect(id).toBe("d1-uuid-fake");
    expect(lastBody).toEqual({ name: "myapp-db" });
  });

  it("provisionCFResource routes d1/r2/kv to the right CF endpoint", async () => {
    server.use(
      http.post(`${CF}/d1/database`, () => ok({ uuid: "d1-x" })),
      http.post(`${CF}/r2/buckets`, () => ok({})),
      http.post(`${CF}/storage/kv/namespaces`, async ({ request }) => {
        lastBody = await request.json();
        return ok({ id: "kv-x" });
      }),
    );
    expect(await provisionCFResource(env, "d1", "db")).toBe("d1-x");
    expect(await provisionCFResource(env, "r2", "bucket")).toBe("bucket"); // R2 id = its name
    expect(await provisionCFResource(env, "kv", "cache")).toBe("kv-x");
    expect(lastBody).toEqual({ title: "cache" }); // KV uses `title`, not `name`
  });

  it("throws on an unknown resource type", async () => {
    await expect(provisionCFResource(env, "queue-x", "q")).rejects.toThrow(/Unknown CF resource type/);
  });

  it("surfaces CF API errors as thrown errors", async () => {
    server.use(
      http.post(`${CF}/d1/database`, () =>
        HttpResponse.json({ success: false, errors: [{ code: 7400, message: "quota exceeded" }] }),
      ),
    );
    await expect(createD1Database(env, "db")).rejects.toThrow(/CF API error.*quota exceeded/);
  });

  it("findExistingCFResource returns the id when a D1 db matches by name", async () => {
    server.use(
      http.get(`${CF}/d1/database`, () =>
        ok([
          { uuid: "other-uuid", name: "other" },
          { uuid: "match-uuid", name: "wanted" },
        ]),
      ),
    );
    expect(await findExistingCFResource(env, "d1", "wanted")).toBe("match-uuid");
  });

  it("getD1Database swallows a CF failure and returns null", async () => {
    server.use(
      http.get(`${CF}/d1/database`, () =>
        HttpResponse.json({ success: false, errors: [{ message: "boom" }] }, { status: 500 }),
      ),
    );
    expect(await getD1Database(env, "db")).toBeNull();
  });
});
