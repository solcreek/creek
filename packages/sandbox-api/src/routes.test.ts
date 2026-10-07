import { describe, expect, it } from "vitest";
import { routes } from "./routes";

// The declared main module is checked right after the body parses, before
// rate limiting or any binding is touched — so these requests need no env.
async function post(body: unknown) {
  const res = await routes.request(
    "/deploy",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    {},
  );
  return { status: res.status, json: (await res.json()) as { error: string; message: string } };
}

const workerBundle = (mainModule: unknown) => ({
  manifest: {
    assets: [],
    hasWorker: true,
    entrypoint: null,
    renderMode: "worker",
    mainModule,
  },
  assets: {},
  serverFiles: { "worker.js": btoa("export default {}") },
  source: "cli",
});

describe("POST /deploy — manifest.mainModule", () => {
  it("rejects a declared main module that is not among the server files", async () => {
    const res = await post(workerBundle("index.js"));
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("validation");
    expect(res.json.message).toContain('"index.js" is not one of the uploaded server files');
  });

  it("rejects an empty or non-string declaration", async () => {
    expect((await post(workerBundle(""))).status).toBe(400);
    expect((await post(workerBundle(7))).json.message).toContain("non-empty string");
  });
});
