import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own, so the write below cannot touch a real one.
const testWorkspace = mkdtempSync(path.join(tmpdir(), "trhai-save-"));
process.env.ASCEND_WORKSPACE = testWorkspace;

const { classifyIntent } = await import("../src/services/actionIntent.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { fakeEngine } = await import("./helpers/fakeEngine.js");

// Keeping something in a named file is a write, whatever the request opens
// with. "fetch https://example.com and save it to example.html" opens with a
// lookup; filed as one, it was offered nothing that writes, so the page could
// be read and never saved.

const fetchAndSave = "fetch https://example.com and save it to example.html";

test("a request to keep something in a named file is an order to write that file", () => {
  for (const order of [
    fetchAndSave,
    "save that as notes.txt",
    "read notes.txt and save a copy as notes-backup.txt",
    "export my schedules to schedules.json",
    "save the output in D:/logs/out.txt"
  ]) {
    const intent = classifyIntent(order);
    assert.deepEqual([intent.action, intent.kind, intent.hasTarget], [true, "write", true], order);
    assert.ok(intent.expects.includes("write_file"), order);
  }

  // Nothing says where: a lookup stays a lookup.
  assert.equal(classifyIntent("fetch https://example.com and save it").kind, "read");
  // "save" that is not about keeping anything in the file named.
  assert.equal(classifyIntent("to save time, read config.json").kind, "read");
  // A question about saving is a question.
  assert.equal(classifyIntent("how do I save a file as notes.txt in Word?").action, false);
  // Told not to.
  assert.notEqual(classifyIntent("don't save it to notes.txt, just show me").kind, "write");
  // A document for the knowledge base names no file, and is handled as before.
  assert.equal(classifyIntent("save a document called Meeting Notes").action, false);
});

const config = (baseUrl: string) => ({ baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 });

test("a page asked to be saved can be read and written", async () => {
  const html = "<h1>Example Domain</h1>";
  // The model writes the file, then says so. (It is not asked to fetch here:
  // a test does not go out to the network.)
  const engine = await fakeEngine({
    reply: [
      { message: { content: "", tool_calls: [{ function: { name: "write_file", arguments: { path: "example.html", content: html } } }] } },
      { message: { content: "Saved the page as example.html." } }
    ]
  });
  try {
    const result = await runAgent(config(engine.baseUrl), fetchAndSave, { memories: [], knowledge: [] });
    const offered = (engine.chats[0].tools ?? []).map((tool) => tool.function.name);
    assert.ok(offered.includes("fetch_url"), `the page can be read: ${offered.join(", ")}`);
    assert.ok(offered.includes("write_file"), `and the file can be written: ${offered.join(", ")}`);

    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    assert.equal(existsSync(path.join(testWorkspace, "example.html")), true, "the file is there");
    assert.equal(readFileSync(path.join(testWorkspace, "example.html"), "utf8"), html);
    if (result.ok) {
      assert.deepEqual(result.toolsUsed, [{ name: "write_file", ok: true }]);
      assert.match(result.text, /example\.html/);
    }
  } finally {
    await engine.close();
  }
});
