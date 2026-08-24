import { lookup as dnsLookup } from "node:dns/promises";

// Reading a page from the web.
//
// Every other tool in this app reaches only this machine's own storage — a
// promise repeated throughout this codebase and checked by
// no-paid-dependencies.test.ts. This is the one deliberate exception: the
// user gives a URL, or asks about something that needs a live page, and
// there is no way to answer that from local files. It costs nothing and
// needs no account, so it does not touch that promise's actual point, which
// is that the user's own data is never sent to a paid service to be
// processed — a public page fetched on the user's behalf is a different
// thing entirely, the same as a browser following a link.
//
// Being the one tool that leaves the machine is also why it gets defences
// none of the others need. A model can be steered by the content of a page
// it just read, and a tool that fetches "whatever URL you're given" is a
// classic SSRF vector if it will fetch anything — including a cloud
// metadata endpoint, or a service on this machine's own network that was
// never meant to be internet-facing. The checks below exist so "fetch a
// web page" cannot become "reach anything on this network".

export type FetchOutcome =
  | { ok: true; url: string; title: string; text: string; truncated: boolean }
  | { ok: false; reason: string };

/** Long enough to be useful context, short enough not to flood the model. */
export const maxExtractedCharacters = 4000;
/** A page is either reasonably sized or it is not a page worth reading in full. */
const maxResponseBytes = 5 * 1024 * 1024;
const fetchTimeoutMs = 10_000;
const maxRedirects = 5;

/**
 * Whether an IP address is loopback, private, or link-local.
 *
 * Pure and address-only — this never resolves a name itself, so it can be
 * tested directly against known addresses without touching a network.
 * Covers the ranges an SSRF attempt actually targets: the machine itself,
 * its LAN, and the link-local block cloud providers use for metadata
 * endpoints (169.254.169.254 is the AWS/GCP/Azure instance-metadata
 * address, reachable from inside a VM the same way a private IP is).
 */
export function isPrivateOrLoopbackAddress(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 0) return true; // "this network"
    return false;
  }

  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true; // link-local
  // Unique local fc00::/7 — covers both fc.. and fd.. prefixes.
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  // ::ffff:a.b.c.d — an IPv4 address expressed in IPv6 form, which resolves
  // the same way and must be checked the same way, not waved through
  // because the text representation looks like IPv6.
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateOrLoopbackAddress(mapped[1]);

  return false;
}

/** hostnames that are always local regardless of what they resolve to. */
const alwaysLocalHostnames = new Set(["localhost", "localhost.localdomain"]);

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * The checks that do not require a network round trip: a real, well-formed
 * http(s) URL with no embedded credentials and no obviously-local hostname.
 * Split out from the DNS-dependent check below so both halves are testable
 * without a real resolver.
 */
export function checkUrlShape(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http and https URLs can be fetched." };
  }

  // "https://user:pass@host/..." — never sent anywhere, refused outright
  // rather than silently stripped, so a caller is not surprised later by
  // credentials that quietly went missing.
  if (url.username || url.password) {
    return { ok: false, reason: "A URL with embedded credentials is refused." };
  }

  const hostname = url.hostname.toLowerCase();
  if (alwaysLocalHostnames.has(hostname) || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "This machine's own address cannot be fetched." };
  }

  return { ok: true, url };
}

/**
 * Resolve `hostname` and refuse if it lands on a loopback, private, or
 * link-local address — the check a hostname alone cannot answer, since a
 * public-looking name can still resolve to an internal address ("DNS
 * rebinding"), and a redirect can point anywhere regardless of where the
 * original URL pointed.
 */
async function resolveIsSafe(
  hostname: string,
  lookup: typeof dnsLookup
): Promise<{ safe: true } | { safe: false; reason: string }> {
  try {
    const { address } = await lookup(hostname);
    if (isPrivateOrLoopbackAddress(address)) {
      return { safe: false, reason: `${hostname} resolves to an address on this machine's own network.` };
    }
    return { safe: true };
  } catch {
    return { safe: false, reason: `${hostname} could not be resolved.` };
  }
}

/** Strip a document down to its title and readable text. No dependency — regex is enough for this. */
export function extractReadableText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().replace(/\s+/g, " ") : "";

  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Block-level tags become a break, so paragraphs do not run together
    // into one unreadable line once the tags themselves are stripped.
    .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const text = decodeEntities(withoutNoise)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();

  return { title, text };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/**
 * Fetch `rawUrl` and return its readable text.
 *
 * Redirects are followed manually, one hop at a time, with the same safety
 * check applied to every hop — `fetch`'s own automatic redirect handling
 * would only ever validate the URL the caller started with, and a page
 * fully within the rules can still redirect somewhere that is not.
 */
export async function fetchWebPage(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
  lookup: typeof dnsLookup = dnsLookup
): Promise<FetchOutcome> {
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const shape = checkUrlShape(current);
    if (!shape.ok) return { ok: false, reason: shape.reason };

    const resolved = await resolveIsSafe(shape.url.hostname, lookup);
    if (!resolved.safe) return { ok: false, reason: resolved.reason };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(shape.url.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Vexora/1.0 (local assistant, fetching a page on the user's behalf)" }
      });
    } catch (error) {
      const detail = error instanceof Error && error.name === "AbortError"
        ? `it did not respond within ${fetchTimeoutMs / 1000}s`
        : "the request failed";
      return { ok: false, reason: `Could not reach that page: ${detail}.` };
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: `The page redirected with no destination given.` };
      current = new URL(location, shape.url).toString();
      continue;
    }

    if (!response.ok) {
      return { ok: false, reason: `The page answered with ${response.status}.` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/^text\/|application\/(xhtml\+xml|json)/i.test(contentType)) {
      return { ok: false, reason: `That page is a ${contentType.split(";")[0] || "non-text"} file, not a readable page.` };
    }

    const reader = response.body?.getReader();
    if (!reader) return { ok: false, reason: "The page returned no content." };

    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "That page is too large to read." };
      }
      chunks.push(value);
    }

    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    const { title, text } = extractReadableText(body);

    if (!text) return { ok: false, reason: "That page had no readable text." };

    const truncated = text.length > maxExtractedCharacters;
    return {
      ok: true,
      url: shape.url.toString(),
      title: title || shape.url.hostname,
      text: truncated ? `${text.slice(0, maxExtractedCharacters)}…` : text,
      truncated
    };
  }

  return { ok: false, reason: "That page redirected too many times." };
}
