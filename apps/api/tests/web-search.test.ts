import test from "node:test";
import assert from "node:assert/strict";
import { parseResults, resolveResultUrl, webSearch, maxSearchResults } from "../src/services/webSearch.js";
import type { RawFetchOutcome } from "../src/services/webFetch.js";
import { wantsWebSearch } from "../src/services/actionIntent.js";
import { runTool } from "../src/services/agentTools.js";

// A DuckDuckGo HTML-endpoint page: two real results, an interleaved sponsored
// slot (a duckduckgo.com/y.js link) that must not be returned, uddg-wrapped
// outbound links, and an entity in a title.
const htmlEndpointPage = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example &amp; Domain</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">This domain is for use in <b>illustrative</b> examples.</a>
</div>
<div class="result result--ad">
  <a class="result__a" href="//duckduckgo.com/y.js?ad_domain=ad.example&amp;u3=x">Buy Example Now</a>
  <div class="result__snippet">Sponsored result.</div>
</div>
<div class="result results_links web-result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwikipedia.org%2Fwiki%2FExample">Example - Wikipedia</a>
  <div class="result__snippet">An example is a representative instance of something.</div>
</div>
`;

// The lite endpoint: table markup, single-quoted attributes, class after href.
const liteEndpointPage = `
<table>
<tr><td>1.&nbsp;</td><td>
  <a rel='nofollow' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example.org%2Fa' class='result-link'>Lite Result One</a>
</td></tr>
<tr><td class='result-snippet'>First lite snippet.</td></tr>
<tr><td>2.&nbsp;</td><td>
  <a rel='nofollow' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example.org%2Fb' class='result-link'>Lite Result Two</a>
</td></tr>
<tr><td class='result-snippet'>Second lite snippet.</td></tr>
</table>
`;

test("resolveResultUrl unwraps DuckDuckGo's outbound redirector", () => {
  assert.equal(
    resolveResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx&rut=abc"),
    "https://example.com/x"
  );
});

test("resolveResultUrl promotes a protocol-relative link to https", () => {
  assert.equal(resolveResultUrl("//example.com/plain"), "https://example.com/plain");
});

test("resolveResultUrl drops links that stay on duckduckgo.com (chrome and ads)", () => {
  assert.equal(resolveResultUrl("//duckduckgo.com/y.js?ad_domain=ad.example"), null);
  assert.equal(resolveResultUrl("/settings"), null);
  assert.equal(resolveResultUrl("javascript:void(0)"), null);
});

test("parseResults reads titles, unwrapped URLs and snippets from the HTML endpoint", () => {
  const results = parseResults(htmlEndpointPage);
  assert.equal(results.length, 2, "the sponsored slot is not a result");

  assert.deepEqual(results[0], {
    title: "Example & Domain",
    url: "https://example.com/page",
    snippet: "This domain is for use in illustrative examples."
  });
  assert.equal(results[1].url, "https://wikipedia.org/wiki/Example");
  assert.equal(results[1].title, "Example - Wikipedia");
  assert.match(results[1].snippet, /representative instance/);
});

test("parseResults also reads the lite endpoint's single-quoted table markup", () => {
  const results = parseResults(liteEndpointPage);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.url), [
    "https://lite.example.org/a",
    "https://lite.example.org/b"
  ]);
  assert.equal(results[0].snippet, "First lite snippet.");
});

test("parseResults returns nothing for a page with no result markup", () => {
  assert.deepEqual(parseResults("<html><body><p>no results here</p></body></html>"), []);
});

/** A canned fetcher: answers each endpoint from a map, no network. */
function cannedFetch(byHost: { lite?: RawFetchOutcome; html?: RawFetchOutcome }) {
  return async (url: string): Promise<RawFetchOutcome> => {
    if (url.includes("lite.duckduckgo.com")) return byHost.lite ?? { ok: false, reason: "not stubbed" };
    if (url.includes("html.duckduckgo.com")) return byHost.html ?? { ok: false, reason: "not stubbed" };
    return { ok: false, reason: "unexpected endpoint" };
  };
}

test("webSearch returns parsed results from the first endpoint that yields them", async () => {
  const outcome = await webSearch("examples", cannedFetch({
    lite: { ok: true, url: "https://lite.duckduckgo.com/lite/", contentType: "text/html", body: liteEndpointPage }
  }));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.query, "examples");
  assert.equal(outcome.results.length, 2);
});

test("webSearch falls back to the next endpoint when the first yields no results", async () => {
  const outcome = await webSearch("examples", cannedFetch({
    lite: { ok: true, url: "https://lite.duckduckgo.com/lite/", contentType: "text/html", body: "<p>nothing</p>" },
    html: { ok: true, url: "https://html.duckduckgo.com/html/", contentType: "text/html", body: htmlEndpointPage }
  }));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.results[0].url, "https://example.com/page");
});

test("webSearch honours the result limit", async () => {
  const outcome = await webSearch(
    "examples",
    cannedFetch({ lite: { ok: true, url: "x", contentType: "text/html", body: htmlEndpointPage } }),
    1
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.results.length, 1);
});

test("webSearch reports an honest miss when the engine returns no results", async () => {
  const empty = { ok: true, url: "x", contentType: "text/html", body: "<p>none</p>" } as const;
  const outcome = await webSearch("examples", cannedFetch({ lite: empty, html: empty }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /no results/i);
});

test("webSearch reports the reach failure when nothing could be fetched", async () => {
  const outcome = await webSearch("examples", cannedFetch({
    lite: { ok: false, reason: "Could not reach that page: the request failed." },
    html: { ok: false, reason: "Could not reach that page: the request failed." }
  }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /could not reach/i);
});

test("webSearch refuses an empty query rather than searching for nothing", async () => {
  const outcome = await webSearch("   ", cannedFetch({}));
  assert.equal(outcome.ok, false);
});

test("maxSearchResults is a small, sane default", () => {
  assert.ok(maxSearchResults >= 3 && maxSearchResults <= 10);
});

// --- gating: when web_search is even offered -------------------------------

test("wantsWebSearch fires on an explicit request to consult the web", () => {
  for (const message of [
    "search the web for otter facts",
    "google the weather in Tokyo",
    "look it up online",
    "search for the typescript 5.5 release notes",
    "what's the latest news on the mars mission",
    "find out the current bitcoin price"
  ]) {
    assert.equal(wantsWebSearch(message), true, message);
  }
});

test("wantsWebSearch stays out of plain questions and local searches", () => {
  for (const message of [
    "what is the capital of France",
    "search my files for TODO",
    "look up the value in my notes",
    "add a line saying hello to notes.txt",
    "explain how promises work"
  ]) {
    assert.equal(wantsWebSearch(message), false, message);
  }
});

// --- dispatch: the tool itself, with the searcher injected -----------------

test("web_search formats the results and points at fetch_url to read one", async () => {
  const result = await runTool(
    { name: "web_search", arguments: { query: "cats" } },
    {
      memories: [], knowledge: [],
      searchWeb: async () => ({
        ok: true, query: "cats",
        results: [
          { title: "All About Cats", url: "https://cats.example/guide", snippet: "Cats are small carnivores." },
          { title: "Cat - Wikipedia", url: "https://wikipedia.org/wiki/Cat", snippet: "" }
        ]
      })
    }
  );
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /Web results for "cats"/);
  assert.match(result.content, /https:\/\/cats\.example\/guide/);
  assert.match(result.content, /https:\/\/wikipedia\.org\/wiki\/Cat/);
  assert.match(result.content, /fetch_url/);
});

test("web_search reports a miss instead of inventing an answer", async () => {
  const result = await runTool(
    { name: "web_search", arguments: { query: "cats" } },
    { memories: [], knowledge: [], searchWeb: async () => ({ ok: false, reason: "the engine may be rate-limiting" }) }
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /found nothing/i);
});

test("web_search needs a query", async () => {
  const result = await runTool(
    { name: "web_search", arguments: {} },
    { memories: [], knowledge: [], searchWeb: async () => ({ ok: true, query: "", results: [] }) }
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /something to search for/i);
});
