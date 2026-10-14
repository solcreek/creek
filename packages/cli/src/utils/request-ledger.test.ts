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
    // Measured with Node's fetch against a local self-signed HTTPS server.
    [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, true],
    // From Node's X509_ERROR_CODE table (src/crypto/crypto_common.cc).
    [{ code: "INVALID_CA" }, true],
    [{ code: "PATH_LENGTH_EXCEEDED" }, true],
    [{ code: "INVALID_PURPOSE" }, true],
    [{ code: "UNABLE_TO_DECRYPT_CERT_SIGNATURE" }, true],
    // TLS errors that can hit an established connection after the request
    // went out: possibly sent.
    [{ code: "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC" }, false],
    // Raised at handshake too (measured: TLS to a plain-HTTP port), but the
    // record layer raises it on an established connection as well.
    [{ code: "ERR_SSL_WRONG_VERSION_NUMBER" }, false],
    // A TLS 1.2 renegotiation after the request can fail with this alert.
    [{ code: "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE" }, false],
    [{ code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR" }, false],
    [{ code: "ERR_TLS_SESSION_ATTACK" }, false],
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
    ledgerOver(fetchFailed({ code: "INVALID_CA" }));
    await expect(fetch("https://api.test/x", { method: "POST" })).rejects.toThrow();
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

  it("sends writes without following redirects, reads unchanged", async () => {
    const seen: (RequestInit | undefined)[] = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push(init);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    installRequestLedger();
    await fetch("https://api.test/x", { method: "POST", body: "{}" });
    await fetch("https://api.test/x");
    expect(seen[0]).toMatchObject({ method: "POST", body: "{}", redirect: "manual" });
    expect(seen[1]).toBeUndefined();
  });
});

describe("a write the server applied and answered with a redirect", () => {
  // Reproduced on Node 24: the server logs the POST, answers 303 to a host
  // that does not resolve, and a followed fetch rejects with ENOTFOUND — the
  // target's error, which reads as "never sent".
  const realFetch = globalThis.fetch;
  let server: import("node:http").Server | undefined;
  afterEach(async () => {
    globalThis.fetch = realFetch;
    resetRequestLedger();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("counts as applied and returns the 3xx instead of failing on its target", async () => {
    const { createServer } = await import("node:http");
    let received = 0;
    server = createServer((req, res) => {
      received++;
      res.writeHead(303, { location: "http://creek-no-such-host.invalid/" });
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    installRequestLedger();
    const response = await fetch(`http://127.0.0.1:${port}/deployments`, {
      method: "POST",
      body: "{}",
    });
    expect(received).toBe(1);
    expect(response.status).toBe(303);
    expect(mutationsMaybeApplied()).toBe(1);
  });
});
