import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Saving a page keeps the page.
//
// Found live on 4 October, on the 7B: "fetch https://example.com and save it
// to example.html". Both tools were called. The file held "<html></html>" -
// thirteen characters - and the reply said "example.html has been created in
// the workspace with the content from "Example Domain"".
//
// A request that says only "fetch this, keep it there" is now carried out
// without a model: what the address serves is what the file holds.

const dataDir = mkdtempSync(path.join(tmpdir(), "trhai-page-"));
const workspace = mkdtempSync(path.join(tmpdir(), "trhai-page-ws-"));
const elsewhere = mkdtempSync(path.join(tmpdir(), "trhai-page-out-"));
process.env.ASCEND_WORKSPACE = workspace;
for (const [name, file] of [["MEMORY", "memory"], ["CONVERSATION", "conversations"], ["ACCOUNTS", "accounts"], ["KNOWLEDGE", "knowledge"], ["TASKS", "tasks"], ["SCHEDULE", "schedules"]]) {
  process.env[`ASSIST_${name}_FILE`] = path.join(dataDir, `${file}.json`);
}
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");
// A dead port: anything here that reached for the model would get no answer from one.
process.env.TRHAI_ENGINE_URL = "http://127.0.0.1:9";

const { pageToKeep } = await import("../src/services/pageSave.js");
const { runAssistantOrchestrator } = await import("../src/services/orchestrator.js");
const { armCommands, commandsArmed, disarmCommands } = await import("../src/services/commandRunner.js");
const { fakeEngine } = await import("./helpers/fakeEngine.js");

test.after(() => {
  for (const dir of [dataDir, workspace, elsewhere]) rmSync(dir, { recursive: true, force: true });
});

test("a request to fetch a page and keep it is read for its address and its file", () => {
  for (const [request, url, file, as] of [
    ["fetch https://example.com and save it to example.html", "https://example.com", "example.html", "page"],
    ["Fetch https://example.com and save it to example.html.", "https://example.com", "example.html", "page"],
    ["can you fetch https://example.com and save it to example.html?", "https://example.com", "example.html", "page"],
    ["save https://example.com as page.html", "https://example.com", "page.html", "page"],
    ["save the page at https://example.com, to pages/example.html", "https://example.com", "pages/example.html", "page"],
    ["grab https://example.com and put it in a file called example.html", "https://example.com", "example.html", "page"],
    ["get https://example.com and save the html to D:/pages/example.html", "https://example.com", "D:/pages/example.html", "page"],
    ["I'd like you to fetch https://example.com and store it in example.html", "https://example.com", "example.html", "page"],
    // A file named in the address is part of the address, not where to keep it.
    ["download https://example.com/data.json to data.json", "https://example.com/data.json", "data.json", "page"],
    // Asked for as text, by the word or by the kind of file.
    ["read https://example.com and save the text to notes.txt", "https://example.com", "notes.txt", "text"],
    ["fetch https://example.com and save it as notes.md", "https://example.com", "notes.md", "text"]
  ] as const) {
    assert.deepEqual(pageToKeep(request), { url, file, as }, request);
  }
});

test("a request that asks for anything more is not one of these", () => {
  for (const request of [
    // Something is to be made of the page first.
    "summarize https://example.com and save the summary to summary.md",
    "fetch https://example.com and save the title to title.txt",
    "fetch https://example.com and save the first paragraph to p.txt",
    "translate https://example.com into French and save it to fr.html",
    "fetch https://example.com, remove the ads and save it to clean.html",
    "fetch https://example.com and save it to example.html 5 times",
    // Not an order to keep it.
    "don't save https://example.com to example.html",
    "how do I save https://example.com to example.html?",
    "read https://example.com in notes.txt",
    "what does https://example.com say? save it to x.html",
    // An address, or a file, is missing - or there are two.
    "fetch https://example.com and save it",
    "read notes.txt and save a copy as notes-backup.txt",
    "fetch https://a.example and https://b.example and save them to both.html"
  ]) {
    assert.equal(pageToKeep(request), null, request);
  }
});

const served = [
  "<!doctype html>",
  "<html>",
  "<head><title>Example Domain</title><style>body { margin: 2em; }</style></head>",
  "<body>",
  "<h1>Example Domain</h1>",
  "<p>This domain is for use in illustrative examples in documents.</p>",
  "<p><a href=\"https://www.iana.org/domains/example\">More information...</a></p>",
  "</body>",
  "</html>",
  ""
].join("\n");

/** A stand-in for the web: answers every address with the page above, and keeps what it was asked for. */
function web(outcome?: { ok: false; reason: string }) {
  const asked: string[] = [];
  return {
    asked,
    fetchPage: async (url: string) => {
      asked.push(url);
      return outcome ?? { ok: true as const, url: "https://example.com/", contentType: "text/html; charset=UTF-8", body: served };
    }
  };
}
const ask = (userMessage: string, fetchPageAsServed: ReturnType<typeof web>["fetchPage"]) =>
  runAssistantOrchestrator({ mode: "general", sessionId: "page-save", userMessage, fetchPageAsServed });

test("the file holds the page as it was served, and the reply says so", async () => {
  const site = web();
  const result = await ask("fetch https://example.com and save it to example.html", site.fetchPage);

  assert.equal(readFileSync(path.join(workspace, "example.html"), "utf8"), served, "every character of it");
  assert.equal(result.assistantMessage,
    `Wrote example.html to the workspace. It holds the page at https://example.com/ as it was served: ${served.length} characters.`);
  assert.equal(result.strategy, "saved");
  assert.equal(result.model, "memory", "no model wrote this");
  assert.deepEqual(result.toolsUsed, [{ name: "fetch_url", ok: true }, { name: "write_file", ok: true }]);
  assert.deepEqual(site.asked, ["https://example.com"], "fetched once");

  // The same page saved again over itself is an ordinary write.
  const again = await ask("fetch https://example.com and save it to example.html", site.fetchPage);
  assert.equal(again.strategy, "saved");
});

test("asked for as text, the file holds what a reader would read", async () => {
  const result = await ask("read https://example.com and save the text to notes.txt", web().fetchPage);
  const kept = readFileSync(path.join(workspace, "notes.txt"), "utf8");
  assert.match(kept, /^Example Domain\n\n/, "the title, then the text");
  assert.match(kept, /This domain is for use in illustrative examples in documents\./);
  assert.match(kept, /More information\.\.\./);
  assert.doesNotMatch(kept, /[<>]|margin: 2em/, "none of the markup or the styling");
  assert.match(result.assistantMessage, /^Wrote notes\.txt to the workspace\. It holds the text of the page at https:\/\/example\.com\/: \d+ characters\.$/);
});

test("a page that cannot be fetched leaves no file, and the reply says why", async () => {
  const result = await ask("fetch https://example.com and save it to missing.html", web({ ok: false, reason: "The page answered with 404." }).fetchPage);
  assert.equal(result.assistantMessage, "Nothing was saved. The page answered with 404.");
  assert.equal(result.strategy, "failed");
  assert.equal(existsSync(path.join(workspace, "missing.html")), false);
});

test("a file that is already there and holds something else is left alone until told to replace it", async () => {
  const mine = "# My notes\n\nMilk\nEggs\nBread\nCall the plumber on Friday\n";
  writeFileSync(path.join(workspace, "kept.html"), mine);

  const refused = await ask("fetch https://example.com and save it to kept.html", web().fetchPage);
  assert.equal(readFileSync(path.join(workspace, "kept.html"), "utf8"), mine, "not a character of it changed");
  assert.equal(refused.assistantMessage,
    "kept.html is already there and holds something else, so it was left as it is. To replace it with the page, "
    + "say the same again with \"overwrite\" in it, or name another file.");
  assert.equal(refused.strategy, "failed");
  assert.deepEqual(refused.toolsUsed, [{ name: "fetch_url", ok: true }, { name: "write_file", ok: false }]);

  const replaced = await ask("fetch https://example.com and save it to kept.html, overwrite", web().fetchPage);
  assert.equal(replaced.strategy, "saved");
  assert.equal(readFileSync(path.join(workspace, "kept.html"), "utf8"), served);
});

test("a file outside the workspace is written only with access to the machine", async () => {
  const target = path.join(elsewhere, "outside.html").replace(/\\/g, "/");
  const request = `fetch https://example.com and save it to ${target}`;
  const wasArmed = commandsArmed();
  disarmCommands();
  try {
    const refused = await ask(request, web().fetchPage);
    assert.equal(existsSync(target), false, "nothing was written there");
    assert.equal(refused.strategy, "failed");
    assert.equal(refused.assistantMessage, "That path is outside my workspace. Turn on machine access and I can reach it. Nothing was written.");

    // The control: the same request with access on.
    armCommands();
    const written = await ask(request, web().fetchPage);
    assert.equal(readFileSync(target, "utf8"), served);
    assert.match(written.assistantMessage, /outside\.html\. It holds the page at https:\/\/example\.com\/ as it was served/);
  } finally {
    if (wasArmed) armCommands();
    else disarmCommands();
  }
});

test("a request that asks for a summary of the page is not carried out here", async () => {
  const site = web();
  const result = await ask("summarize https://example.com and save the summary to summary.md", site.fetchPage);
  assert.deepEqual(site.asked, [], "nothing was fetched on its behalf");
  assert.notEqual(result.strategy, "saved");
  assert.equal(existsSync(path.join(workspace, "summary.md")), false);
});

test("the same stand-in for the web is what fetch_url reads inside a model's turn", async () => {
  // A request that is the model's to answer, with a model that reads the page first.
  const engine = await fakeEngine({
    reply: [
      { message: { content: "", tool_calls: [{ function: { name: "fetch_url", arguments: { url: "https://example.com" } } }] } },
      { message: { content: "It says the domain is for use in illustrative examples in documents." } }
    ]
  });
  const dead = process.env.TRHAI_ENGINE_URL;
  process.env.TRHAI_ENGINE_URL = engine.baseUrl;
  const site = web();
  try {
    const result = await runAssistantOrchestrator({
      mode: "general", sessionId: "page-read", userMessage: "What does the web page at https://example.com say?", fetchPageAsServed: site.fetchPage
    });
    assert.deepEqual(site.asked, ["https://example.com"], "the page came from the stand-in, not from the web");
    const shown = engine.chats.at(-1)?.messages?.find((message) => message.role === "tool")?.content;
    assert.match(String(shown), /^From "Example Domain" \(https:\/\/example\.com\/\):\n/, "as fetch_url gives a page to a model");
    assert.match(String(shown), /This domain is for use in illustrative examples in documents\./);
    assert.equal(result.strategy, "generated");
  } finally {
    process.env.TRHAI_ENGINE_URL = dead;
    await engine.close();
  }
});
