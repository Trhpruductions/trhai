import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { fakeEngine } from "./helpers/fakeEngine.js";

// A web address is something to read. It is not a file.
//
// Two things read one as a file:
//
// - The pattern for a drive path - a letter, a colon, a slash - also matched
//   the end of an address's scheme: "https://example.com" read as the drive
//   "s:" and the path "//example.com". So a request with an address in it
//   "named a file", and was code work. In the evaluation, "What does the web
//   page at https://example.com say?" went to the coding model in both runs,
//   whichever model the conversation had chosen.
// - The classifier counted an address as the target of any verb. The same
//   question was filed as asking for "the contents of a named file", wanting
//   read_file. And "Write a two-sentence summary of https://example.com" was
//   an order to write a file: answered in words, it was pushed to call a file
//   writer instead.
//
// Every store the route touches is a temporary directory set before server.js
// loads.
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-web-address-"));
process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "ascend-web-address-ws-"));
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASSIST_TASK_FILE = path.join(dataDir, "tasks.json");
process.env.ASSIST_TASK_HISTORY_FILE = path.join(dataDir, "task-history.json");
process.env.ASSIST_TOOL_USAGE_FILE = path.join(dataDir, "tool-usage.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { classifyIntent, drivePath, namesAFilePath } = await import("../src/services/actionIntent.js");
const { isCodeWork } = await import("../src/services/machinePaths.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { createApp } = await import("../src/server.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const page = "What does the web page at https://example.com say?";
const summary = "Write a two-sentence summary of https://example.com";

test("a drive letter stands on its own, so the end of a web address's scheme is not one", () => {
  for (const address of [
    page,
    "summarize https://example.com/docs/guide",
    "fetch http://localhost:3000/health and tell me what it says",
    "open ws://127.0.0.1:9000/socket"
  ]) {
    assert.equal(drivePath.test(address), false, address);
    assert.equal(namesAFilePath(address), false, address);
    assert.equal(isCodeWork("general", address), false, address);
  }

  // The controls: real drive paths, however they are written.
  for (const file of [
    "fix D:/projects/app/src/index.ts please",
    "edit C:\\Users\\me\\thing.js",
    "what's in d:/notes/todo.txt",
    "copy it to (D:/backup/site.html)"
  ]) {
    assert.equal(drivePath.test(file), true, file);
    assert.equal(namesAFilePath(file), true, file);
    assert.equal(isCodeWork("general", file), true, file);
  }
  // An address and a file in one request: the file still counts.
  assert.equal(namesAFilePath("fetch https://example.com and save it to D:/pages/example.html"), true);
});

test("an address is read as a page, and is never the file a write is for", () => {
  // Asking what a page says wants the page reader, not the file reader.
  const asked = classifyIntent(page);
  assert.deepEqual([asked.action, asked.kind, asked.reason, asked.expects],
    [true, "read", "asks about the page at a named address", ["fetch_url"]]);
  // The control: the same question of a file still wants the file reader.
  assert.deepEqual(classifyIntent("What does D:/notes/todo.txt say?").expects, ["read_file"]);
  // And a file named inside an address is part of the address.
  assert.deepEqual(classifyIntent("What does https://example.com/readme.md say?").expects, ["fetch_url"]);

  // Words about a page are not an order to write a file.
  for (const words of [summary, "Create a short description of the page at https://example.com"]) {
    assert.equal(classifyIntent(words).action, false, words);
  }
  // The controls: with a file to put it in, it is one - and an edit of a
  // file that mentions an address still is.
  const kept = classifyIntent("write the title of https://example.com to title.txt");
  assert.deepEqual([kept.action, kept.kind, kept.hasTarget], [true, "write", true]);
  const edited = classifyIntent("add https://example.com to links.md");
  assert.deepEqual([edited.action, edited.kind, edited.hasTarget], [true, "write", true]);
});

const config = (baseUrl: string) => ({ baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 });
const context = { memories: [], knowledge: [] };

test("words about a page are offered the page reader and no file writer, and are the answer", async () => {
  const written = "Example Domain is a placeholder page. It is reserved for use in examples.";
  const engine = await fakeEngine({ reply: { message: { content: written } } });
  const offered = (index: number) => (engine.chats[index]?.tools ?? []).map((tool) => tool.function.name);
  try {
    const result = await runAgent(config(engine.baseUrl), summary, context);
    assert.ok(offered(0).includes("fetch_url"), `the page can be read: ${offered(0).join(", ")}`);
    for (const writer of ["write_file", "edit_file"]) assert.ok(!offered(0).includes(writer), `${writer} is not offered for words about a page`);
    // Answered in words, and that is the answer: not sent back to "use a file tool".
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (result.ok) assert.equal(result.text, written);
    assert.equal(engine.chats.length, 1, "asked once, with no push to call a tool");

    // The control: with a file to put it in, the writers are offered.
    const before = engine.chats.length;
    await runAgent(config(engine.baseUrl), "write the title of https://example.com to title.txt", context);
    assert.ok(offered(before).includes("write_file"), `a file to write is named: ${offered(before).join(", ")}`);
  } finally {
    await engine.close();
  }
});

test("a question about a page is answered by the conversation's own model, and a file by the coding model", async () => {
  // Both models installed, and the conversation has chosen the thinking one.
  const engine = await fakeEngine({ models: ["qwen2.5-coder-7b", "qwen3-8b"], reply: { message: { content: "It says Example Domain." } } });
  const previous = process.env.TRHAI_ENGINE_URL;
  process.env.TRHAI_ENGINE_URL = engine.baseUrl;
  const app = createApp().listen(0, "127.0.0.1");
  await once(app, "listening");
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const ask = async (sessionId: string, message: string) => {
    const before = engine.chats.length;
    const response = await fetch(`${base}/v1/assist`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "general", sessionId, message, model: "qwen3-8b" })
    });
    assert.equal(response.status, 200);
    await response.json();
    return engine.chats.slice(before).map((chat) => chat.model);
  };
  try {
    const forThePage = await ask("web-address-page", page);
    assert.ok(forThePage.length > 0, "the model was asked");
    assert.deepEqual([...new Set(forThePage)], ["qwen3-8b"], "the model the conversation chose, and only that one");

    // The control: a file on a drive is code work, and goes to the coding model first.
    const forTheFile = await ask("web-address-file", "what's in D:/projects/app/server.js?");
    assert.equal(forTheFile[0], "qwen2.5-coder-7b");
  } finally {
    if (previous === undefined) delete process.env.TRHAI_ENGINE_URL;
    else process.env.TRHAI_ENGINE_URL = previous;
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await engine.close();
  }
});
