/**
 * Which email domains cannot receive mail. Cloudflare Access emails its
 * one-time PIN to whoever signs in, so a listed address on a domain without
 * mail can never sign in: the login page still says a code was sent.
 *
 * Asked of Cloudflare's DNS-over-HTTPS resolver, the company that already
 * holds the allow-list. A domain counts as without mail when it does not
 * exist, has no MX record, or publishes a null MX (RFC 7505). A lookup that
 * fails or times out says nothing: the domain is not reported.
 */

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const LOOKUP_TIMEOUT_MS = 2500;
/** Beyond this many domains, the rest go unchecked. */
export const MAX_MAIL_LOOKUPS = 25;

const NOERROR = 0;
const NXDOMAIN = 3;
const MX = 15;

interface DnsJson {
  Status?: number;
  Answer?: { type?: number; data?: string }[];
}

async function receivesMail(domain: string): Promise<boolean | null> {
  try {
    const url = `${DOH_URL}?name=${encodeURIComponent(domain)}&type=MX`;
    const res = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as DnsJson;
    if (body.Status === NXDOMAIN) return false;
    if (body.Status !== NOERROR) return null;
    const exchanges = (body.Answer ?? [])
      .filter((a) => a.type === MX && typeof a.data === "string")
      .map((a) => a.data!.trim().split(/\s+/)[1] ?? "");
    return exchanges.some((host) => host !== "." && host !== "");
  } catch {
    return null;
  }
}

/** The domains, among those given, known not to receive mail; sorted. */
export async function domainsWithoutMail(domains: Iterable<string>): Promise<string[]> {
  const unique = [...new Set([...domains].map((d) => d.toLowerCase()))].slice(0, MAX_MAIL_LOOKUPS);
  const results = await Promise.all(unique.map(async (d) => [d, await receivesMail(d)] as const));
  return results
    .filter(([, ok]) => ok === false)
    .map(([d]) => d)
    .sort();
}
