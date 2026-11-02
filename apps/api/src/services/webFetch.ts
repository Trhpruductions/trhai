import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

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
//
// The name is resolved once, every address it has is checked, and the
// connection is then made to one of those very addresses (pinnedFetch): a
// name that answered with a public address to the check and a private one to
// the connection - DNS rebinding - gets nowhere, because the connection never
// asks the resolver again.

export type FetchOutcome =
  | { ok: true; url: string; title: string; text: string; truncated: boolean }
  | { ok: false; reason: string };

/** Long enough to be useful context, short enough not to flood the model. */
export const maxExtractedCharacters = 4000;
/** A page is either reasonably sized or it is not a page worth reading in full. */
const maxResponseBytes = 5 * 1024 * 1024;
/** From the request going out to the last byte of the body: a slow drip is as much a hang as silence. */
export const fetchTimeoutMs = 10_000;
const maxRedirects = 5;

type Hextets = number[];

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function hextetsOf(ip: string): Hextets | null {
  let text = ip.toLowerCase();
  // ::ffff:a.b.c.d - the IPv4 tail becomes the last two groups.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted.slice(2, 6).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    text = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(text) || (text.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = text.split("::");
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => (group === "" ? NaN : parseInt(group, 16))));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  if ([...left, ...right].some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 1) return null;
  return [...left, ...Array<number>(tail === undefined ? 0 : missing).fill(0), ...right];
}

function isPrivateV4(a: number, b: number, c: number): boolean {
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 0) return true; // "this network"
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT (100.64/10), incl. Tailscale
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking (198.18/15)
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast and reserved, incl. broadcast
  return false;
}

/**
 * Whether an IP address is loopback, private, link-local, or otherwise not a
 * place on the public internet.
 *
 * Pure and address-only — this never resolves a name itself, so it can be
 * tested directly against known addresses without touching a network.
 * Covers the ranges an SSRF attempt actually targets: the machine itself,
 * its LAN, carrier-NAT and VPN ranges, the link-local block cloud providers
 * use for metadata endpoints (169.254.169.254 is the AWS/GCP/Azure
 * instance-metadata address, reachable from inside a VM the same way a
 * private IP is), multicast, and the IPv6 forms that carry an IPv4 address
 * inside them.
 */
export function isPrivateOrLoopbackAddress(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return true; // not an address at all: never fetched
    return isPrivateV4(octets[0], octets[1], octets[2]);
  }

  const groups = hextetsOf(ip.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  if (!groups) return true; // not an address: never fetched
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const allZeroTo = (count: number) => groups.slice(0, count).every((group) => group === 0);
  if (allZeroTo(7) && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
  const embeddedV4 = (hi: number, lo: number) => isPrivateV4(hi >> 8, hi & 0xff, lo >> 8);
  if (allZeroTo(5) && g5 === 0xffff) return embeddedV4(g6, g7); // ::ffff:a.b.c.d, IPv4-mapped
  if (allZeroTo(4) && g4 === 0xffff && g5 === 0) return embeddedV4(g6, g7); // ::ffff:0:a.b.c.d, IPv4-translated
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embeddedV4(g6, g7); // 64:ff9b::/96, NAT64
  if (g0 === 0x2002) return embeddedV4(g1, g2); // 2002::/16, 6to4
  if (g0 === 0x2001 && g1 === 0) return embeddedV4(g6 ^ 0xffff, g7 ^ 0xffff); // 2001::/32, Teredo: the client address, bitwise inverted, is the tail
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
  if (alwaysLocalHostnames.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return { ok: false, reason: "This machine's own address cannot be fetched." };
  }

  return { ok: true, url };
}

export type ResolvedAddress = { address: string; family: 4 | 6 };

type LookupResult = ResolvedAddress | ResolvedAddress[] | { address: string; family: number } | Array<{ address: string; family: number }>;

/**
 * Every address `hostname` has, each checked: a name that resolves to several
 * addresses is as reachable at its last as at its first, and a resolver that
 * answers a public address first and a private one second is the oldest trick
 * there is. Refuses if any address is not public, so the connection that
 * follows can use any of them.
 */
async function resolveAddresses(
  hostname: string,
  lookup: typeof dnsLookup
): Promise<{ safe: true; addresses: ResolvedAddress[] } | { safe: false; reason: string }> {
  let found: LookupResult;
  try {
    // A stand-in resolver in a test may answer one address whatever it is asked.
    found = await (lookup as unknown as (name: string, options: { all: true }) => Promise<LookupResult>)(hostname, { all: true });
  } catch {
    return { safe: false, reason: `${hostname} could not be resolved.` };
  }
  const list = (Array.isArray(found) ? found : [found]).filter((entry) => entry && typeof entry.address === "string");
  if (list.length === 0) return { safe: false, reason: `${hostname} could not be resolved.` };
  for (const entry of list) {
    if (isPrivateOrLoopbackAddress(entry.address)) {
      return { safe: false, reason: `${hostname} resolves to an address on this machine's own network.` };
    }
  }
  return { safe: true, addresses: list.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 })) };
}

/** Strip a document down to its title and readable text. No dependency — regex is enough for this. */
export function extractReadableText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().replace(/\s+/g, " ") : "";

  const withoutNoise = html
    // The title is returned on its own. Left in, it also opened the text -
    // "Example Domain This domain is for use in..." - read twice.
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, " ")
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

export function decodeEntities(value: string): string {
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

export type RawFetchOutcome =
  | { ok: true; url: string; contentType: string; body: string }
  | { ok: false; reason: string };

/**
 * A non-GET request, and an optional User-Agent override.
 *
 * The search endpoints answer only to a form POST, and only serve results to a
 * browser-like agent — a text-browser-style page for a text-browser-style
 * caller. fetch_url keeps the honest default; search overrides it, the same as
 * a real browser identifies itself when it asks those endpoints for the same
 * no-JavaScript page.
 */
export type RawFetchOptions = { method?: string; body?: string; contentType?: string; userAgent?: string; timeoutMs?: number };

/** How the request identifies itself. One string, so every route uses the same. */
const userAgent = "TRH-AI/1.0 (local assistant, fetching a page on the user's behalf)";

function abortError(signal: AbortSignal | null | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("This operation was aborted", "AbortError");
}

/**
 * fetch, connecting only to the addresses it is given.
 *
 * Node's fetch resolves the name again when it connects, and nothing passed to
 * it changes that. This one resolves nothing: the name in the URL goes in the
 * Host header and the TLS handshake, and the socket is opened to one of the
 * addresses already checked. Redirects are left to the caller (as with
 * redirect: "manual"), and the body is a stream, so the caller's size and time
 * limits apply as they do with fetch.
 */
export function pinnedFetch(addresses: ResolvedAddress[]): typeof fetch {
  const lookup = (_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    if (wantsAll) callback(null, addresses.map((entry) => ({ address: entry.address, family: entry.family })));
    else callback(null, addresses[0].address, addresses[0].family);
  };
  return ((input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    const signal = init.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const body = typeof init.body === "string" ? init.body : undefined;
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    headers.connection = "close";
    const transport = url.protocol === "https:" ? https : http;

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      let answer: http.IncomingMessage | null = null;
      const request = transport.request(url, { method: init.method ?? "GET", headers, lookup: lookup as never, agent: false }, (incoming) => {
        settled = true;
        answer = incoming;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        const status = incoming.statusCode ?? 502;
        const empty = status === 204 || status === 304 || (init.method ?? "GET").toUpperCase() === "HEAD";
        if (empty) incoming.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>), {
          status, statusText: incoming.statusMessage ?? "", headers: responseHeaders
        }));
      });
      const onAbort = () => {
        const reason = abortError(signal);
        (answer as http.IncomingMessage | null)?.destroy(reason);
        request.destroy(reason);
        if (!settled) reject(reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      request.once("close", () => signal?.removeEventListener("abort", onAbort));
      request.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(signal?.aborted ? abortError(signal) : new TypeError("fetch failed", { cause: error }));
      });
      if (body !== undefined) request.write(body);
      request.end();
    });
  }) as typeof fetch;
}

/**
 * Fetch `rawUrl` and return its raw body text, with every network-facing
 * defence applied but no readable-text extraction.
 *
 * This is the primitive the rest of this module is built on: fetchWebPage
 * layers text extraction over it, and webSearch parses a results page's HTML
 * out of it. Keeping the SSRF, redirect, size and timeout handling in one
 * place is deliberate — it is the one code path in this app that leaves the
 * machine, and a second copy of it would be a second thing to get wrong.
 *
 * `options` carries a non-GET request — the search endpoints answer only to a
 * form POST. A redirect is always followed as a bodyless GET, the way a
 * browser turns a POST that redirects into a GET of the destination.
 *
 * Redirects are followed manually, one hop at a time, with the same safety
 * check applied to every hop — `fetch`'s own automatic redirect handling
 * would only ever validate the URL the caller started with, and a page
 * fully within the rules can still redirect somewhere that is not.
 *
 * `fetchImpl` is for tests: left out, the request is made by pinnedFetch to
 * the addresses the check resolved, so the name is never resolved twice.
 */
export async function fetchRawPage(
  rawUrl: string,
  fetchImpl?: typeof fetch,
  lookup: typeof dnsLookup = dnsLookup,
  options: RawFetchOptions = {}
): Promise<RawFetchOutcome> {
  let current = rawUrl;
  let requestMethod = (options.method ?? "GET").toUpperCase();
  let requestBody = options.body;
  let requestContentType = options.contentType;
  const timeoutMs = options.timeoutMs ?? fetchTimeoutMs;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const shape = checkUrlShape(current);
    if (!shape.ok) return { ok: false, reason: shape.reason };

    const resolved = await resolveAddresses(shape.url.hostname, lookup);
    if (!resolved.safe) return { ok: false, reason: resolved.reason };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timedOut = () => ({ ok: false as const, reason: `Could not reach that page: it did not finish within ${timeoutMs / 1000}s.` });

    const headers: Record<string, string> = { "User-Agent": options.userAgent ?? userAgent };
    if (requestBody !== undefined && requestContentType) headers["Content-Type"] = requestContentType;

    try {
      let response: Response;
      try {
        response = await (fetchImpl ?? pinnedFetch(resolved.addresses))(shape.url.toString(), {
          method: requestMethod,
          redirect: "manual",
          signal: controller.signal,
          headers,
          ...(requestBody !== undefined ? { body: requestBody } : {})
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return timedOut();
        return { ok: false, reason: "Could not reach that page: the request failed." };
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!location) return { ok: false, reason: `The page redirected with no destination given.` };
        current = new URL(location, shape.url).toString();
        // Whatever the first hop was, its destination is fetched as a plain GET.
        requestMethod = "GET";
        requestBody = undefined;
        requestContentType = undefined;
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { ok: false, reason: `The page answered with ${response.status}.` };
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!/^text\/|application\/(xhtml\+xml|json)/i.test(contentType)) {
        await response.body?.cancel().catch(() => {});
        return { ok: false, reason: `That page is a ${contentType.split(";")[0] || "non-text"} file, not a readable page.` };
      }

      const reader = response.body?.getReader();
      if (!reader) return { ok: false, reason: "The page returned no content." };

      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        let piece: Awaited<ReturnType<typeof reader.read>>;
        try {
          piece = await reader.read();
        } catch {
          // The timer fired while the body was still coming, or the connection broke.
          return controller.signal.aborted ? timedOut() : { ok: false, reason: "Could not reach that page: the connection broke while it was being read." };
        }
        if (piece.done) break;
        received += piece.value.byteLength;
        if (received > maxResponseBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "That page is too large to read." };
        }
        chunks.push(piece.value);
      }

      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
      return { ok: true, url: shape.url.toString(), contentType, body };
    } finally {
      // Cleared only once the body has been read, or given up on: the limit is on the whole page.
      clearTimeout(timer);
    }
  }

  return { ok: false, reason: "That page redirected too many times." };
}

/** A link a reader can follow: its words, and where it goes. */
export type PageLink = { text: string; url: string };

/**
 * The links in a page, made absolute, in the order they appear: web links
 * only (no mailto:, javascript:, data:), one per address, each with words to
 * show - a link with no text is an icon, and nothing a reader can read.
 */
export function extractLinks(html: string, baseUrl: string, limit = 80): PageLink[] {
  const links: PageLink[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null && links.length < limit) {
    const href = decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    url.hash = "";
    const text = decodeEntities(match[4].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 140);
    if (!text || seen.has(url.href)) continue;
    seen.add(url.href);
    links.push({ text, url: url.href });
  }
  return links;
}

/** How much of a page a person reading it is given - far more than the model's share. */
export const maxReadCharacters = 60_000;

export type PageReading =
  | { ok: true; url: string; title: string; text: string; truncated: boolean; links: PageLink[] }
  | { ok: false; reason: string };

/**
 * A page for a person to read: the same fetch as fetch_url, behind the same
 * checks on where it may go, with more of the text and the links in it, so
 * the Browser workspace can follow them. Text only - nothing on the page runs.
 */
export async function readWebPage(
  rawUrl: string,
  fetchImpl?: typeof fetch,
  lookup: typeof dnsLookup = dnsLookup
): Promise<PageReading> {
  const raw = await fetchRawPage(rawUrl, fetchImpl, lookup);
  if (!raw.ok) return raw;

  const { title, text } = extractReadableText(raw.body);
  if (!text) return { ok: false, reason: "That page had no readable text." };

  const truncated = text.length > maxReadCharacters;
  return {
    ok: true,
    url: raw.url,
    title: title || new URL(raw.url).hostname,
    text: truncated ? `${text.slice(0, maxReadCharacters)}…` : text,
    truncated,
    links: extractLinks(raw.body, raw.url)
  };
}

/**
 * Fetch `rawUrl` and return its readable text — the page read behind fetch_url.
 * Thin over fetchRawPage: fetch safely, then strip the document to title and
 * text.
 */
export async function fetchWebPage(
  rawUrl: string,
  fetchImpl?: typeof fetch,
  lookup: typeof dnsLookup = dnsLookup
): Promise<FetchOutcome> {
  return readablePage(await fetchRawPage(rawUrl, fetchImpl, lookup));
}

/** A fetched page as fetch_url gives it to a model: its title, and its text up to the model's share. */
export function readablePage(raw: RawFetchOutcome): FetchOutcome {
  if (!raw.ok) return raw;

  const { title, text } = extractReadableText(raw.body);
  if (!text) return { ok: false, reason: "That page had no readable text." };

  const truncated = text.length > maxExtractedCharacters;
  return {
    ok: true,
    url: raw.url,
    title: title || new URL(raw.url).hostname,
    text: truncated ? `${text.slice(0, maxExtractedCharacters)}…` : text,
    truncated
  };
}
