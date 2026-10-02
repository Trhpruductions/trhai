import test from "node:test";
import assert from "node:assert/strict";
import { back, emptyHistory, forward, hostOf, looksLikeUrl, normalizeUrl, paragraphsOf, visit } from "../src/lib/browser.js";

// The Browser workspace's address bar, paragraphs and history.

test("an address is told from words to search for", () => {
  assert.equal(looksLikeUrl("https://example.com/docs"), true);
  assert.equal(looksLikeUrl("example.com"), true);
  assert.equal(looksLikeUrl("docs.example.co.uk/guide?x=1"), true);
  assert.equal(looksLikeUrl("localhost:3000"), false, "no dot, no address - and this machine is refused anyway");
  assert.equal(looksLikeUrl("node.js release schedule"), false, "words with a dot are still a search");
  assert.equal(looksLikeUrl("what is a race condition"), false);
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("http://example.com"), "http://example.com");
});

test("a site is named the way a person names it", () => {
  assert.equal(hostOf("https://www.example.com/a/b"), "example.com");
  assert.equal(hostOf("https://docs.example.com/"), "docs.example.com");
});

test("a page's text becomes paragraphs", () => {
  assert.deepEqual(paragraphsOf("First   line.\n\n\n  Second\tpart.  \n \nThird."), ["First line.", "Second part.", "Third."]);
  assert.deepEqual(paragraphsOf("  \n\n "), []);
});

test("Back and Forward walk the visits, and going somewhere new drops what Forward led to", () => {
  let history = visit(emptyHistory, { kind: "search", query: "race condition" });
  history = visit(history, { kind: "page", url: "https://a.example/" });
  history = visit(history, { kind: "page", url: "https://b.example/" });
  history = back(history);
  assert.deepEqual(history.visits[history.index], { kind: "page", url: "https://a.example/" });
  history = forward(history);
  assert.equal(history.index, 2);
  history = back(back(history));
  history = visit(history, { kind: "page", url: "https://c.example/" });
  assert.deepEqual(history.visits.map((entry) => (entry.kind === "page" ? entry.url : entry.query)), ["race condition", "https://c.example/"]);
  assert.equal(forward(history), history, "nothing ahead");
  assert.equal(visit(history, { kind: "page", url: "https://c.example/" }), history, "the same visit twice is one visit");
});
