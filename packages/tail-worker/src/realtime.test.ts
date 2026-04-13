/**
 * Realtime push tests — mock global fetch and assert URL, headers,
 * body shape, and HMAC token are all correct. Realtime is best-effort,
 * so we also verify failure modes don't propagate.
 */

import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { pushBatchToRealtime } from "./realtime.js";
import type { LogEntry } from "./types.js";

const MASTER_KEY = "test-master-key-for-hmac";
const REALTIME_URL = "https://realtime.example.com";

interface FetchCall {
  url: string;
  method: string;
  body: string;
  authHeader: string | null;
}

let calls: FetchCall[];
let nextResponse: () => Response;

beforeEach(() => {
  calls = [];
  nextResponse = () => new Response("", { status: 200 });
  vi.stubGlobal("fetch", (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      authHeader: headers.get("Authorization"),
    });
    return Promise.resolve(nextResponse());
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    v: 1,
    timestamp: 1700000000000,
    team: "acme",
    project: "blog",
    scriptType: "production",
    outcome: "ok",
    request: { url: "https://x.com/", method: "GET", status: 200 },
    logs: [],
    exceptions: [],
    ...overrides,
  };
}

describe("pushBatchToRealtime", () => {
  test("REALTIME_URL unset → no fetch (dev mode no-op)", async () => {
    await pushBatchToRealtime({ REALTIME_MASTER_KEY: MASTER_KEY }, [entry()]);
    expect(calls).toEqual([]);
  });

  test("REALTIME_MASTER_KEY unset → no fetch", async () => {
    await pushBatchToRealtime({ REALTIME_URL }, [entry()]);
    expect(calls).toEqual([]);
  });

  test("empty batch → no fetch", async () => {
    await pushBatchToRealtime(
      { REALTIME_URL, REALTIME_MASTER_KEY: MASTER_KEY },
      [],
    );
    expect(calls).toEqual([]);
  });

  test("single entry → one POST to /{slug}/rooms/logs/broadcast with HMAC", async () => {
    await pushBatchToRealtime(
      { REALTIME_URL, REALTIME_MASTER_KEY: MASTER_KEY },
      [entry()],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${REALTIME_URL}/acme-blog/rooms/logs/broadcast`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].authHeader).toMatch(/^Bearer [0-9a-f]{64}$/);
    const body = JSON.parse(calls[0].body);
    expect(body.type).toBe("log");
    expect(body.entry).toMatchObject({ team: "acme", project: "blog" });
  });

  test("entries with hyphenated team or project → URL-safe slug", async () => {
    await pushBatchToRealtime(
      { REALTIME_URL, REALTIME_MASTER_KEY: MASTER_KEY },
      [entry({ team: "acme-corp", project: "vite-react-drizzle" })],
    );
    expect(calls[0].url).toBe(
      `${REALTIME_URL}/acme-corp-vite-react-drizzle/rooms/logs/broadcast`,
    );
  });

  test("entries split across (team, project) → separate POST per slug", async () => {
    await pushBatchToRealtime(
      { REALTIME_URL, REALTIME_MASTER_KEY: MASTER_KEY },
      [
        entry({ team: "acme", project: "blog" }),
        entry({ team: "acme", project: "shop" }),
        entry({ team: "bob", project: "blog" }),
      ],
    );
    const slugs = calls.map((c) => c.url.split("/").slice(-4)[0]).sort();
    expect(slugs).toEqual(["acme-blog", "acme-shop", "bob-blog"]);
  });

  test("HMAC token is HMAC-SHA256(master_key, slug) — same scheme as realtime-worker verifies", async () => {
    // Hand-compute expected token so the test catches any silent
    // change to the auth scheme. Realtime-worker verifies with the
    // same algorithm; if these drift, broadcasts get 401.
    const expectedToken = await computeHmac(MASTER_KEY, "acme-blog");
    await pushBatchToRealtime(
      { REALTIME_URL, REALTIME_MASTER_KEY: MASTER_KEY },
      [entry()],
    );
    expect(calls[0].authHeader).toBe(`Bearer ${expectedToken}`);
  });

  test("realtime returns 401 → does NOT throw (best-effort)", async () => {
    nextResponse = () => new Response("unauthorized", { status: 401 });
    await expect(
      pushBatchToRealtime(
        { REALTIME_URL, REALTIME_MASTER_KEY: MASTER_KEY },
        [entry()],
      ),
    ).resolves.toBeUndefined();
  });

  test("fetch throws (network error) → does NOT throw (best-effort)", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));
    await expect(
      pushBatchToRealtime(
        { REALTIME_URL, REALTIME_MASTER_KEY: MASTER_KEY },
        [entry()],
      ),
    ).resolves.toBeUndefined();
  });

  test("base URL with trailing slash is normalized — no double slash", async () => {
    await pushBatchToRealtime(
      { REALTIME_URL: `${REALTIME_URL}/`, REALTIME_MASTER_KEY: MASTER_KEY },
      [entry()],
    );
    expect(calls[0].url).toBe(`${REALTIME_URL}/acme-blog/rooms/logs/broadcast`);
  });
});

async function computeHmac(masterKey: string, slug: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(slug),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
