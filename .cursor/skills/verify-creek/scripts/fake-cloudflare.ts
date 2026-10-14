/**
 * Bun preload for the local control-plane (control-plane.sh start with
 * VERIFY_CREEK_FAKE_CLOUDFLARE=1): answers every api.cloudflare.com request
 * in-process and records it, so a deploy job runs to the end and its worker
 * upload — the bindings the worker gets — can be read back.
 *
 * Nothing reaches Cloudflare: requests are answered here, and the server only
 * holds a fake token in case one ever were not.
 *
 * Each request is one JSON line in $VERIFY_CREEK_CF_LOG:
 *   { method, path, metadata? }
 * where `metadata` is a worker upload's metadata part (bindings included).
 */
import { appendFileSync } from "node:fs";

const LOG = process.env.VERIFY_CREEK_CF_LOG;
if (!LOG) throw new Error("fake-cloudflare: VERIFY_CREEK_CF_LOG is not set");

const realFetch = globalThis.fetch;
let counter = 0;

async function metadataOf(body: unknown): Promise<unknown> {
  if (!(body instanceof FormData)) return undefined;
  const part = body.get("metadata");
  if (part === null) return undefined;
  return JSON.parse(typeof part === "string" ? part : await part.text());
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.cloudflare.com/")) return realFetch(input, init);

  const method = (
    init?.method ??
    (input instanceof Request ? input.method : undefined) ??
    "GET"
  ).toUpperCase();
  const path = url.slice("https://api.cloudflare.com/client/v4".length);
  const metadata = await metadataOf(init?.body);
  appendFileSync(LOG, JSON.stringify({ method, path, ...(metadata ? { metadata } : {}) }) + "\n");

  const respond = (status: number, body: object) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  // The fake keeps no state, so nothing ever exists: a single R2 bucket's GET
  // is always a 404 (getR2Bucket reads success as "exists"), and lists
  // (find-before-create) are always empty. Every lookup misses and
  // provisioning always creates, even for a name created earlier in the run.
  if (method === "GET" && /\/r2\/buckets\/[^/?]+$/.test(path)) {
    return respond(404, {
      success: false,
      errors: [{ code: 10006, message: "The specified bucket does not exist." }],
      messages: [],
      result: null,
    });
  }
  // Everything else succeeds with the fields provisioning (D1 uuid, KV id,
  // queue_id) and the asset upload (jwt, buckets) read.
  const id = `fake-${++counter}`;
  const result =
    method === "GET"
      ? []
      : { id, uuid: id, name: id, queue_id: id, jwt: `fake-jwt-${counter}`, buckets: [] };
  return respond(200, { success: true, errors: [], messages: [], result });
}) as typeof fetch;
