/**
 * What this CLI run has possibly changed on a server, so a network failure
 * can say whether re-running the command is safe.
 *
 * A command can make several requests (`creek deploy`: create the project,
 * create the deployment, upload). If a later one fails, the earlier ones may
 * already be applied, and re-running the command would apply them again —
 * requests carry no idempotency key. The ledger counts every mutating request
 * (any method but GET/HEAD/OPTIONS) that may have been applied: one that got
 * a 2xx, 3xx or 5xx, or one that failed in a way that does not prove nothing
 * was sent. A 4xx is a refusal and is not counted.
 */

/**
 * Causes of Node/undici's `TypeError("fetch failed")` that prove the request
 * was never written: name resolution, the TCP connect, and the TLS handshake
 * all happen first. Anything else is counted as possibly sent.
 */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
]);
/** Causes undici raises before opening a connection; they carry no code. */
const NOT_SENT_MESSAGES: ReadonlySet<string> = new Set(["bad port", "unknown scheme"]);
/**
 * TLS failures raised before the request is written. Node verifies the
 * certificate once, in the handshake (onConnectSecure, before secureConnect),
 * and reports a failure under OpenSSL's X509 verify error names (Node's
 * src/crypto/crypto_common.cc). Any other TLS/SSL error counts as possibly
 * sent: the safe direction, which can only make the CLI more cautious.
 */
const CERT_VERIFY_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CRL_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
]);
/**
 * Node's own TLS errors raised only before the connection is usable: the
 * hostname check (checkServerIdentity, before secureConnect). OpenSSL's
 * ERR_SSL_* errors are not listed — the record layer and renegotiation can
 * raise any of them (a wrong version number, a handshake-failure alert) on an
 * established connection after the request went out.
 */
const HANDSHAKE_TLS_CODES: ReadonlySet<string> = new Set(["ERR_TLS_CERT_ALTNAME_INVALID"]);
const isTlsFailure = (reason: string) =>
  CERT_VERIFY_CODES.has(reason) || HANDSHAKE_TLS_CODES.has(reason);

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

let maybeApplied = 0;

/**
 * Whether an error is undici's network failure: `fetch failed` before a
 * response, or `terminated` when the connection breaks while the body is read
 * (fetch resolved on the headers; measured on Node 24: cause UND_ERR_SOCKET).
 */
export function isNetworkFailure(err: unknown): err is TypeError {
  return (
    err instanceof TypeError && (err.message === "fetch failed" || err.message === "terminated")
  );
}

/** The reason undici gives for a network failure: `cause.code`, else `cause.message`. */
export function fetchFailureReason(err: unknown): string | undefined {
  if (!isNetworkFailure(err)) return undefined;
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return undefined;
}

/** Whether a fetch rejection proves the request was never written. */
export function provablyNotSent(err: unknown): boolean {
  // A body that breaks off follows a response: the request went out.
  if (!(err instanceof TypeError) || err.message !== "fetch failed") return false;
  const reason = fetchFailureReason(err);
  if (reason === undefined) return false;
  return NOT_SENT_CODES.has(reason) || NOT_SENT_MESSAGES.has(reason) || isTlsFailure(reason);
}

function methodOf(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  const method = init?.method ?? (input instanceof Request ? input.method : undefined) ?? "GET";
  return method.toUpperCase();
}

/**
 * Count this run's mutating requests that may have reached a server.
 *
 * Mutating requests are sent with `redirect: "manual"`. Followed, a redirect
 * turns the failure of its target (ENOTFOUND, a certificate error) into the
 * request's own, and a write the server applied before answering 303/307/308
 * would read as never sent. Unfollowed, a failure is the first hop's, and the
 * 3xx comes back to the caller, counted as applied. Creek's APIs never answer
 * a write with a redirect.
 */
export function installRequestLedger(): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const mutating = !SAFE_METHODS.has(methodOf(input, init));
    try {
      const response = await original(input, mutating ? { ...init, redirect: "manual" } : init);
      // A 4xx is a refusal, nothing applied. A 2xx or 3xx answered it, and a
      // 5xx may have failed midway.
      if (mutating && (response.status < 400 || response.status >= 500)) maybeApplied++;
      return response;
    } catch (err) {
      if (mutating && !provablyNotSent(err)) maybeApplied++;
      throw err;
    }
  }) as typeof fetch;
}

/** Mutating requests this run that may have been applied. */
export function mutationsMaybeApplied(): number {
  return maybeApplied;
}

/** Tests only. */
export function resetRequestLedger(): void {
  maybeApplied = 0;
}
