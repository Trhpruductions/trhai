import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

// The Browser workspace: a page for a person to read - its text, more of it
// than the model is given, and the links in it - behind the same checks on
// where a fetch may go.

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-browser-"));
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");
const { extractLinks, maxExtractedCharacters, maxReadCharacters, readWebPage } = await import("../src/services/webFetch.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const page = (body: string, title = "A page") => `<!doctype html><html><head><title>${title}</title><script>steal()</script></head><body>${body}</body></html>`;

/**
 * A stand-in for the network: one page, and a resolver that answers with the
 * address given - one record, as dns.lookup does without { all: true }. (An
 * array here made every lookup "fail to resolve", so the refusal test below
 * passed without ever reaching the private-address check it is about.)
 */
function network(html: string, address = "93.184.216.34") {
  let fetched = 0;
  const fetchImpl = (async () => {
    fetched += 1;
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }) as unknown as typeof fetch;
  const lookup = (async () => ({ address, family: 4 })) as unknown as typeof import("node:dns/promises").lookup;
  return { fetchImpl, lookup, fetched: () => fetched };
}

test("links are made absolute, kept once each, and only the ones a person can read and follow", () => {
  const html = `
    <a href="/docs/start">Getting started</a>
    <a href='https://other.example/x#section'>Elsewhere</a>
    <a href=relative.html>Relative &amp; plain</a>
    <a href="/docs/start">Getting started again</a>
    <a href="mailto:someone@example.com">Write to us</a>
    <a href="javascript:alert(1)">Run this</a>
    <a href="/icon"><img src="x.png"></a>`;
  assert.deepEqual(extractLinks(html, "https://site.example/guide/index.html"), [
    { text: "Getting started", url: "https://site.example/docs/start" },
    { text: "Elsewhere", url: "https://other.example/x" },
    { text: "Relative & plain", url: "https://site.example/guide/relative.html" }
  ]);
});

test("a page is read as its title, its text without scripts, and its links", async () => {
  const { fetchImpl, lookup } = network(page(`<h1>Welcome</h1><p>First paragraph.</p><p>Second, with <a href="/more">more</a>.</p>`));
  const read = await readWebPage("https://site.example/", fetchImpl, lookup);
  assert.ok(read.ok);
  assert.equal(read.title, "A page");
  assert.match(read.text, /Welcome/);
  assert.match(read.text, /First paragraph\./);
  assert.doesNotMatch(read.text, /steal/, "nothing on the page runs, or even shows");
  assert.doesNotMatch(read.text, /A page/, "the title is returned on its own, not read twice");
  assert.deepEqual(read.links, [{ text: "more", url: "https://site.example/more" }]);
  assert.equal(read.truncated, false);
});

test("a person is given far more of a long page than the model, and told when it is cut", async () => {
  assert.ok(maxReadCharacters > maxExtractedCharacters * 10);
  const { fetchImpl, lookup } = network(page(`<p>${"word ".repeat(20_000)}</p>`));
  const read = await readWebPage("https://site.example/long", fetchImpl, lookup);
  assert.ok(read.ok);
  assert.equal(read.truncated, true);
  assert.ok(read.text.length <= maxReadCharacters + 1);
});

test("a name that resolves to this machine or the local network is refused, as it is for the model", async () => {
  for (const address of ["127.0.0.1", "192.168.1.20", "169.254.169.254"]) {
    const { fetchImpl, lookup, fetched } = network(page("<p>internal</p>"), address);
    const read = await readWebPage("https://looks-public.example/", fetchImpl, lookup);
    assert.equal(read.ok, false, `${address} refused`);
    assert.match(read.ok ? "" : read.reason, /this machine's own network/, "refused for where it resolves, not for failing to");
    assert.equal(fetched(), 0, "and never fetched");
  }
});

test("the routes refuse an empty search and a URL that is not one, before anything is fetched", async () => {
  const server = createApp().listen(0);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/v1/web/search?q=`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/v1/web/read?url=${encodeURIComponent("not a url")}`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/v1/web/read?url=${encodeURIComponent("file:///C:/Windows/win.ini")}`)).status, 400);
    const local = await fetch(`${baseUrl}/v1/web/read?url=${encodeURIComponent("http://localhost:4000/v1/files")}`);
    assert.equal(local.status, 400);
    assert.match(((await local.json()) as { message: string }).message, /own address/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
