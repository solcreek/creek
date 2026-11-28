/**
 * Which email domains cannot, or may not, receive mail. Cloudflare Access
 * emails its one-time PIN to whoever signs in, so a listed address on a
 * domain without mail can never sign in: the login page still says a code
 * was sent.
 *
 * Asked of Cloudflare's DNS-over-HTTPS resolver, the company that already
 * holds the allow-list. Two verdicts:
 *   - noMail: the domain does not exist, or publishes a null MX (RFC 7505).
 *     Mail to it cannot be delivered.
 *   - noMx: the domain exists but has no MX record. SMTP may still fall back
 *     to its A/AAAA records (RFC 5321 §5.1), so this is a likely problem,
 *     not a certain one: a web host's address rarely accepts mail.
 * A lookup that fails or times out says nothing: the domain is not reported.
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

type Verdict = "mail" | "noMail" | "noMx" | "unknown";

async function lookup(domain: string): Promise<Verdict> {
  try {
    const url = `${DOH_URL}?name=${encodeURIComponent(domain)}&type=MX`;
    const res = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return "unknown";
    const body = (await res.json()) as DnsJson;
    if (body.Status === NXDOMAIN) return "noMail";
    if (body.Status !== NOERROR) return "unknown";
    const exchanges = (body.Answer ?? [])
      .filter((a) => a.type === MX && typeof a.data === "string")
      .map((a) => a.data!.trim().split(/\s+/)[1] ?? "");
    if (!exchanges.length) return "noMx";
    return exchanges.some((host) => host !== "." && host !== "") ? "mail" : "noMail";
  } catch {
    return "unknown";
  }
}

export interface MailCheck {
  /** Domains mail cannot reach. */
  noMail: string[];
  /** Domains with no MX record: mail most likely fails. */
  noMx: string[];
}

/** Checks the given domains (de-duplicated, at most MAX_MAIL_LOOKUPS); each list sorted. */
export async function checkMailDomains(domains: Iterable<string>): Promise<MailCheck> {
  const unique = [...new Set([...domains].map((d) => d.toLowerCase()))].slice(0, MAX_MAIL_LOOKUPS);
  const results = await Promise.all(unique.map(async (d) => [d, await lookup(d)] as const));
  const pick = (v: Verdict) =>
    results
      .filter(([, r]) => r === v)
      .map(([d]) => d)
      .sort();
  return { noMail: pick("noMail"), noMx: pick("noMx") };
}
