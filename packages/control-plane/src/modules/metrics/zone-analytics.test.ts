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

  test("returns null when no hostnames passed", async () => {
    const result = await queryZoneHttpAnalyticsMerged(envWithToken(), [], 24);
    expect(result).toBeNull();
  });

  test("returns null when all hostnames' zones are unknown", async () => {
    // /zones?name=... returns empty result → getZoneId returns null →
    // per-hostname query returns null → merged returns null.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ result: [] }),
    });

    const result = await queryZoneHttpAnalyticsMerged(
      envWithToken(),
      ["external.customer.example", "another.external.example"],
      24,
    );
    expect(result).toBeNull();
  });

  test("merges totals and series across hostnames with aligned buckets", async () => {
    // Two hostnames, both on zones we own. Dispatch by URL: zone
    // lookups hit /zones?name= and GraphQL hits /graphql. Concurrent
    // fetches via Promise.all would otherwise arrive in mixed order,
    // so switching on a call counter is fragile.
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/zones?name=")) {
        return {
          ok: true,
          json: async () => ({ result: [{ id: "zone" }] }),
        };
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
                    {
                      dimensions: { datetimeFifteenMinutes: "2026-04-17T12:00:00Z" },
                      count: 50,
                    },
                    {
                      dimensions: { datetimeFifteenMinutes: "2026-04-17T12:15:00Z" },
                      count: 50,
                    },
                  ],
                  cachedSeries: [
                    {
                      dimensions: { datetimeFifteenMinutes: "2026-04-17T12:00:00Z" },
                      count: 20,
                    },
                    {
                      dimensions: { datetimeFifteenMinutes: "2026-04-17T12:15:00Z" },
                      count: 20,
                    },
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
    );
    expect(result).not.toBeNull();
    // Two hostnames each contributing 100 reqs → 200 merged
    expect(result!.totals.reqs).toBe(200);
    expect(result!.totals.cachedReqs).toBe(80);
    expect(result!.totals.errs).toBe(10);
    // Two series points per host, both aligned on same timestamps → 2 merged points
    expect(result!.series).toHaveLength(2);
    expect(result!.series[0].reqs).toBe(100);
    expect(result!.series[0].cachedReqs).toBe(40);
  });

  test("skips hostnames whose zone lookup fails, keeps the rest", async () => {
    // Dispatch by URL + target zone name. Hostnames here span two
    // different zone names so Promise.all concurrency doesn't confuse
    // the mock.
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/zones?name=customer.example")) {
        return { ok: true, json: async () => ({ result: [] }) };
      }
      if (u.includes("/zones?name=creek.dev")) {
        return { ok: true, json: async () => ({ result: [{ id: "z-b" }] }) };
      }
      // GraphQL
      return {
        ok: true,
        json: async () => ({
          data: {
            viewer: {
              zones: [
                {
                  totals: [{ count: 7 }],
                  cached: [{ count: 2 }],
                  series: [],
                  cachedSeries: [],
                  errors: [{ count: 0 }],
                },
              ],
            },
          },
        }),
      };
    });

    const result = await queryZoneHttpAnalyticsMerged(
      envWithToken(),
      ["external.customer.example", "known.creek.dev"],
      24,
    );
    expect(result).not.toBeNull();
    expect(result!.totals.reqs).toBe(7);
    expect(result!.totals.cachedReqs).toBe(2);
  });
});
