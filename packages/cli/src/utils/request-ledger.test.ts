import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installRequestLedger,
  mutationsMaybeApplied,
  provablyNotSent,
  resetRequestLedger,
} from "./request-ledger.js";

/** undici's shape for a network failure: a fixed message, the reason on `cause`. */
const fetchFailed = (cause: { code?: string; message?: string }) =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error(cause.message ?? "x"), cause),
  });

describe("provablyNotSent", () => {
  it.each([
    // Before anything is written: name resolution, connect, TLS handshake.
    [{ code: "ENOTFOUND" }, true],
    [{ code: "EAI_AGAIN" }, true],
    [{ code: "ECONNREFUSED" }, true],
    [{ code: "UND_ERR_CONNECT_TIMEOUT" }, true],
    [{ message: "bad port" }, true],
    [{ message: "unknown scheme" }, true],
    [{ code: "CERT_HAS_EXPIRED" }, true],
    [{ code: "SELF_SIGNED_CERT_IN_CHAIN" }, true],
    [{ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }, true],
    [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, true],
    // Possibly after the request was written.
    [{ code: "ECONNRESET" }, false],
    [{ code: "EPIPE" }, false],
    [{ code: "ETIMEDOUT" }, false],
    [{ code: "EHOSTUNREACH" }, false],
    [{ code: "ENETUNREACH" }, false],
    [{ code: "UND_ERR_SOCKET" }, false],
    [{ code: "UND_ERR_HEADERS_TIMEOUT" }, false],
    [{ code: "SOMETHING_NEW" }, false],
  ])("%j → %s", (cause, expected) => {
    expect(provablyNotSent(fetchFailed(cause))).toBe(expected);
  });

  it("is false for anything that is not undici's fetch failure", () => {
    expect(provablyNotSent(new TypeError("fetch failed"))).toBe(false);
    expect(provablyNotSent(new Error("boom"))).toBe(false);
  });
});

describe("installRequestLedger", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetRequestLedger();
  });

  /** Install the ledger over a fetch that answers or rejects as given. */
  function ledgerOver(outcome: Response | Error) {
    globalThis.fetch = vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome.clone();
    }) as typeof fetch;
    installRequestLedger();
  }

  it("does not count reads", async () => {
    ledgerOver(new Response("{}", { status: 200 }));
    await fetch("https://api.test/projects");
    await fetch("https://api.test/projects", { method: "HEAD" });
    await fetch(new Request("https://api.test/projects"));
    expect(mutationsMaybeApplied()).toBe(0);
  });

  it("counts a mutation that succeeded or got a 5xx, not one refused with a 4xx", async () => {
    ledgerOver(new Response("{}", { status: 201 }));
    await fetch("https://api.test/projects", { method: "POST" });
    expect(mutationsMaybeApplied()).toBe(1);

    resetRequestLedger();
    globalThis.fetch = realFetch;
    ledgerOver(new Response("{}", { status: 409 }));
    await fetch("https://api.test/projects", { method: "POST" });
    expect(mutationsMaybeApplied()).toBe(0);

    globalThis.fetch = realFetch;
    ledgerOver(new Response("{}", { status: 502 }));
    await fetch("https://api.test/projects", { method: "DELETE" });
    expect(mutationsMaybeApplied()).toBe(1);
  });

  it("counts a failed mutation unless it provably was not sent", async () => {
    ledgerOver(fetchFailed({ code: "ECONNREFUSED" }));
    await expect(fetch("https://api.test/x", { method: "PUT" })).rejects.toThrow();
    expect(mutationsMaybeApplied()).toBe(0);

    globalThis.fetch = realFetch;
    ledgerOver(fetchFailed({ code: "ECONNRESET" }));
    await expect(fetch("https://api.test/x", { method: "PUT" })).rejects.toThrow();
    expect(mutationsMaybeApplied()).toBe(1);
  });

  it("reads the method of a Request object", async () => {
    ledgerOver(new Response("{}", { status: 200 }));
    await fetch(new Request("https://api.test/x", { method: "PATCH" }));
    expect(mutationsMaybeApplied()).toBe(1);
  });
});
