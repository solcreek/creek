import { describe, test, expect, vi, beforeEach } from "vitest";
import { extractZoneName, queryZoneHttpAnalyticsMerged } from "./zone-analytics.js";

describe("extractZoneName", () => {
  test("takes last two labels for standard domains", () => {
    expect(extractZoneName("www.creek.dev")).toBe("creek.dev");
    expect(extractZoneName("app.creek.dev")).toBe("creek.dev");
    expect(extractZoneName("site-team.bycreek.com")).toBe("bycreek.com");
    expect(extractZoneName("api.foo.example.io")).toBe("example.io");
  });

  test("returns the input unchanged for bare apex domains", () => {
    expect(extractZoneName("creek.dev")).toBe("creek.dev");
    expect(extractZoneName("example.com")).toBe("example.com");
  });

  test("returns the input when only one label (edge case)", () => {
    expect(extractZoneName("localhost")).toBe("localhost");
  });
});

describe("queryZoneHttpAnalyticsMerged", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  function envWithToken() {
    return {
      CLOUDFLARE_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CREEK_DOMAIN: "bycreek.com",
    } as unknown as Parameters<typeof queryZoneHttpAnalyticsMerged>[0];
  }

  // A unique "unroutable" fallbackZone for tests that need the fallback
  // to never resolve. Real callers pass their CREEK_DOMAIN; here we use
  // a sentinel so dual-zone expansion doesn't double-contribute data.
  const NO_FALLBACK = "no-such-zone.invalid";

  test("returns null when no hostnames passed", async () => {
    const result = await queryZoneHttpAnalyticsMerged(envWithToken(), [], 24, NO_FALLBACK);
    expect(result).toBeNull();
  });

  test("returns null when all hostname + fallback zones are unknown", async () => {
    // Zone lookup empty → per-query null → merged null.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ result: [] }),
    });

    const result = await queryZoneHttpAnalyticsMerged(
      envWithToken(),
      ["external.customer.example", "another.external.example"],
      24,
      NO_FALLBACK,
    );
    expect(result).toBeNull();
  });

  test("merges totals + series across hostnames, skipping unresolved fallback", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      // Only own zones resolve; fallback is unknown.
      if (u.includes("/zones?name=one.com") || u.includes("/zones?name=two.com")) {
        return { ok: true, json: async () => ({ result: [{ id: "zone" }] }) };
      }
      if (u.includes("/zones?name=")) {
        return { ok: true, json: async () => ({ result: [] }) };
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            viewer: {
              zones: [
                {
                  totals: [{ count: 100 }],
                  cached: [{ count: 40 }],
                  series: [
                    { dimensions: { datetimeFifteenMinutes: "2026-04-17T12:00:00Z" }, count: 50 },
                    { dimensions: { datetimeFifteenMinutes: "2026-04-17T12:15:00Z" }, count: 50 },
                  ],
                  cachedSeries: [
                    { dimensions: { datetimeFifteenMinutes: "2026-04-17T12:00:00Z" }, count: 20 },
                    { dimensions: { datetimeFifteenMinutes: "2026-04-17T12:15:00Z" }, count: 20 },
                  ],
                  errors: [{ count: 5 }],
                },
              ],
            },
          },
        }),
      };
    });

    const result = await queryZoneHttpAnalyticsMerged(
      envWithToken(),
      ["a.one.com", "b.two.com"],
      24,
      NO_FALLBACK,
    );
    expect(result).not.toBeNull();
    // Two hostnames × 100 each = 200 (fallback unresolved → no extra contribution)
    expect(result!.totals.reqs).toBe(200);
    expect(result!.totals.cachedReqs).toBe(80);
    expect(result!.totals.errs).toBe(10);
    expect(result!.series).toHaveLength(2);
    expect(result!.series[0].reqs).toBe(100);
    expect(result!.series[0].cachedReqs).toBe(40);
  });

  test("fallback zone captures traffic invisible to own zone (CF for SaaS)", async () => {
    // Simulate the creek.dev apex case: hostname's own zone (creek.dev)
    // returns empty; the fallback origin zone (bycreek.com) holds the
    // traffic. Merged result should reflect the fallback data.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/zones?name=creek.dev")) {
        return { ok: true, json: async () => ({ result: [{ id: "z-own" }] }) };
      }
      if (u.includes("/zones?name=bycreek.com")) {
        return { ok: true, json: async () => ({ result: [{ id: "z-fallback" }] }) };
      }
      // GraphQL: empty for own zone, populated for fallback zone.
      const body = (init?.body as string) ?? "";
      const isFallback = body.includes("z-fallback");
      if (isFallback) {
        return {
          ok: true,
          json: async () => ({
            data: {
              viewer: {
                zones: [
                  {
                    totals: [{ count: 265 }],
                    cached: [{ count: 180 }],
                    series: [],
                    cachedSeries: [],
                    errors: [{ count: 0 }],
                  },
                ],
              },
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: { viewer: { zones: [{ totals: [], cached: [], series: [], cachedSeries: [], errors: [] }] } },
        }),
      };
    });

    const result = await queryZoneHttpAnalyticsMerged(
      envWithToken(),
      ["creek.dev"],
      24,
      "bycreek.com",
    );
    expect(result).not.toBeNull();
    expect(result!.totals.reqs).toBe(265);
    expect(result!.totals.cachedReqs).toBe(180);
  });
});
