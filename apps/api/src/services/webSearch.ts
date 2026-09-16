import { fetchRawPage, decodeEntities, type RawFetchOutcome, type RawFetchOptions } from "./webFetch.js";

// Searching the web, without an account or an API key.
//
// fetch_url can read a page the user already has the address for; it cannot
// find one. This is the other half: a query in, a handful of real result
// links out, so the model can then fetch_url the one that answers the
// question. It is the second tool that leaves the machine, and it leaves it
// the same careful way fetch_url does - through fetchRawPage, with all of that
// module's SSRF, redirect, size and timeout defences - because a search
// results page is still a page fetched from the internet.
//
// No paid search API is used, and none may be added (see
// no-paid-dependencies.test.ts and the standing "no API keys" rule). DuckDuckGo
// publishes no-JavaScript HTML endpoints that need no key and set no account
// cookie; we request one the same way a text browser would and parse the
// result links out of the HTML. This is scraping, and scraping is fragile: the
// markup can change and the engine can rate-limit an automated caller. Both
// show up here as an honest "no results", never as an invented answer - the
// whole app is built on not claiming what did not happen.

export type SearchResult = { title: string; url: string; snippet: string };

export type SearchOutcome =
  | { ok: true; query: string; results: SearchResult[] }
  | { ok: false; reason: string };

/** Enough to choose from, few enough not to flood the model's context. */
export const maxSearchResults = 5;

/**
 * The no-key endpoints, tried in order until one yields results. Lite first:
 * its markup is the simplest and the most stable to parse. Both answer only to
 * a form POST — a GET returns the search box, not results — so the query goes
 * in the request body, not the URL.
 */
const searchEndpoints = [
  "https://lite.duckduckgo.com/lite/",
  "https://html.duckduckgo.com/html/"
];

/**
 * The endpoints serve results only to a browser-like agent — the honest
 * "Vexora" agent gets an empty 202. This is a real browser string because that
 * is who these no-JavaScript pages are for; it is not sent anywhere else.
 */
const searchUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Strip a fragment of result HTML down to plain text. */
function cleanText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Turn a result anchor's href into an absolute, off-DuckDuckGo URL, or null.
 *
 * DuckDuckGo wraps outbound links through its own redirector
 * (`//duckduckgo.com/l/?uddg=<encoded target>`); the real destination is the
 * `uddg` parameter. Anything that stays on duckduckgo.com after unwrapping is
 * the engine's own chrome or a sponsored `y.js` ad slot, not a result, and is
 * dropped - an ad returned as a result would be exactly the kind of thing the
 * user did not ask for presented as though they had.
 */
export function resolveResultUrl(href: string): string | null {
  let target = (href ?? "").trim();
  if (!target) return null;

  const wrapped = /[?&]uddg=([^&]+)/.exec(target);
  if (wrapped) {
    try {
      target = decodeURIComponent(wrapped[1]);
    } catch {
      return null;
    }
  } else if (target.startsWith("//")) {
    target = `https:${target}`;
  }

  if (!/^https?:\/\//i.test(target)) return null;
  try {
    const url = new URL(target);
    const host = url.hostname.toLowerCase();
    if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Parse result links and snippets out of a DuckDuckGo no-JS results page.
 *
 * Handles both endpoints' markup: the HTML endpoint's `result__a` /
 * `result__snippet` and the lite endpoint's `result-link` / `result-snippet`,
 * in either quote style. Pure and given the page text directly, so it is
 * tested against saved HTML with no network involved.
 *
 * Title and snippet are paired by position: for each result anchor, the
 * snippet is the first one appearing before the next result anchor. Zipping
 * two independent lists would misalign the moment a result has no snippet.
 */
export function parseResults(html: string): SearchResult[] {
  const anchors: Array<{ tag: string; inner: string; end: number }> = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    const tag = match[1];
    if (/\bresult__a\b/.test(tag) || /\bresult-link\b/.test(tag)) {
      anchors.push({ tag, inner: match[2], end: anchorRe.lastIndex });
    }
  }

  const snippetRe = /class=['"][^'"]*result[_-]{1,2}snippet[^'"]*['"][^>]*>([\s\S]*?)<\/(?:a|div|td|span|p)>/i;
  const hrefRe = /href=['"]([^'"]+)['"]/i;

  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const hrefMatch = hrefRe.exec(anchor.tag);
    if (!hrefMatch) continue;
    const url = resolveResultUrl(hrefMatch[1]);
    if (!url || seen.has(url)) continue;

    const title = cleanText(anchor.inner);
    if (!title) continue;

    const nextStart = index + 1 < anchors.length ? anchors[index + 1].end : html.length;
    const segment = html.slice(anchor.end, nextStart);
    const snippetMatch = snippetRe.exec(segment);
    const snippet = snippetMatch ? cleanText(snippetMatch[1]) : "";

    seen.add(url);
    results.push({ title, url, snippet });
  }
  return results;
}

/**
 * Search the web for `query` and return the top results.
 *
 * `fetchRaw` is injected so a test drives this against saved results HTML with
 * no network call, exactly as fetch_url's dispatch is tested; the real
 * fetchRawPage, with its defences, is the default.
 */
export async function webSearch(
  query: string,
  fetchRaw: (url: string, options?: RawFetchOptions) => Promise<RawFetchOutcome> =
    (url, options) => fetchRawPage(url, undefined, undefined, options),
  limit: number = maxSearchResults
): Promise<SearchOutcome> {
  const cleaned = (query ?? "").trim();
  if (!cleaned) return { ok: false, reason: "A search needs something to search for." };

  const post: RawFetchOptions = {
    method: "POST",
    body: `q=${encodeURIComponent(cleaned)}`,
    contentType: "application/x-www-form-urlencoded",
    userAgent: searchUserAgent
  };

  let fetched = false;
  let lastReason = "the search engine could not be reached";
  for (const url of searchEndpoints) {
    const raw = await fetchRaw(url, post);
    if (!raw.ok) {
      lastReason = raw.reason;
      continue;
    }
    fetched = true;
    const results = parseResults(raw.body).slice(0, limit);
    if (results.length > 0) return { ok: true, query: cleaned, results };
  }

  return {
    ok: false,
    reason: fetched
      ? "the search returned no results (the engine may be rate-limiting automated searches)"
      : lastReason
  };
}
