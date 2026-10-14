/**
 * What this CLI run has possibly changed on a server, so a network failure
 * can say whether re-running the command is safe.
 *
 * A command can make several requests (`creek deploy`: create the project,
 * create the deployment, upload). If a later one fails, the earlier ones may
 * already be applied, and re-running the command would apply them again —
 * requests carry no idempotency key. The ledger counts every mutating request
 * (any method but GET/HEAD/OPTIONS) that may have been applied: one that
 * succeeded or got a 5xx, or one that failed in a way that does not prove
 * nothing was sent. A 4xx is a refusal and is not counted.
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
/** TLS/certificate failures: the handshake precedes the request. */
const TLS_CODE = /^(CERT_|ERR_TLS_|ERR_SSL_)|SELF_SIGNED|UNABLE_TO_(VERIFY|GET)/;

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

let maybeApplied = 0;

/** The reason undici gives for a failed fetch: `cause.code`, else `cause.message`. */
export function fetchFailureReason(err: unknown): string | undefined {
  if (!(err instanceof TypeError) || err.message !== "fetch failed") return undefined;
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return undefined;
}

/** Whether a fetch rejection proves the request was never written. */
export function provablyNotSent(err: unknown): boolean {
  const reason = fetchFailureReason(err);
  if (reason === undefined) return false;
  return NOT_SENT_CODES.has(reason) || NOT_SENT_MESSAGES.has(reason) || TLS_CODE.test(reason);
}

function methodOf(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  const method = init?.method ?? (input instanceof Request ? input.method : undefined) ?? "GET";
  return method.toUpperCase();
}

/** Count this run's mutating requests that may have reached a server. */
export function installRequestLedger(): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const mutating = !SAFE_METHODS.has(methodOf(input, init));
    try {
      const response = await original(input, init);
      // A 4xx is a refusal, nothing applied; a 5xx may have failed midway.
      if (mutating && (response.ok || response.status >= 500)) maybeApplied++;
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
