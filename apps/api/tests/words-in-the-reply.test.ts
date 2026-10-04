import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own, so the write below cannot touch a real one.
const testWorkspace = mkdtempSync(path.join(tmpdir(), "trhai-words-"));
process.env.ASCEND_WORKSPACE = testWorkspace;

const { asksForWordsInTheReply } = await import("../src/services/actionIntent.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { fakeEngine } = await import("./helpers/fakeEngine.js");

// Words asked for are written in the reply.
//
// Found live on 3 October: "Write a very long, detailed story of at least 3000
// words about a lighthouse keeper and a storm" was answered by a write_file
// call carrying the story. Nothing appeared on screen while it was written, a
// file nobody asked for (story_lighthouse.txt) appeared in the workspace, and
// one run wrote for the whole 180 s time limit and ended as "did not finish
// its reply". Qwen3 did the same with "Write a function... Reply with just
// the code". The file writers were on offer for both, because nothing about
// the request said they should not be.

test("a request for something to read is told from a request for something to keep", () => {
  for (const words of [
    "Write a very long, detailed story of at least 3000 words about a lighthouse keeper and a storm.",
    "Write a two-sentence product description for a stainless steel water bottle that keeps drinks cold for 24 hours.",
    "write a haiku about autumn",
    "Tell me a joke about printers",
    "Give me a list of five dog breeds",
    "Compose a limerick about my cat, keep it short",
    "Could you write a poem about the sea?",
    "Please draft an email to my landlord about the heating",
    "Create a checklist for packing",
    "Write a function that reverses a string",
    // A shop, not an order to store anything.
    "Write a story about a store that sells clocks",
    // Said outright, whatever else the sentence holds.
    "Write a JavaScript function unique(arr) that removes duplicates from an array while keeping the original order. Reply with just the code.",
    "Write a function that strips the extension from a file name. Reply with just the code.",
    "Explain closures, and don't create any files",
    "Show me the fix here in the chat"
  ]) {
    assert.equal(asksForWordsInTheReply(words), true, words);
  }

  for (const kept of [
    // The words are to be kept.
    "Write a story about a lighthouse keeper and save it",
    "Write a poem and store it as a note",
    "Write a summary of the meeting, then save that to my documents",
    "Write a story into a new document",
    // Somewhere on disk is named.
    "create a folder with the name recipes",
    "write a list of chores in a file",
    // Not an order to compose anything.
    "add a guard to the greet function",
    "fix the typo in the heading",
    "write tests for the parser",
    "build me a todo app",
    "write it down",
    "create the config. Then write a note about it",
    "What is a haiku?",
    ""
  ]) {
    assert.equal(asksForWordsInTheReply(kept), false, kept);
  }
});

const config = (baseUrl: string) => ({ baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 });
const context = { memories: [], knowledge: [] };
const story = "Write a very long, detailed story of at least 3000 words about a lighthouse keeper and a storm.";

test("a story, and code asked for in the reply, are not offered the tools that write files", async () => {
  const engine = await fakeEngine();
  // The tools the latest chat request offered the model, by name.
  const offered = () => (engine.chats.at(-1)?.tools ?? []).map((tool) => tool.function.name);
  try {
    await runAgent(config(engine.baseUrl), story, context);
    assert.ok(offered().length > 0, "the request still has tools: it can look things up");
    for (const writer of ["write_file", "edit_file", "write_document"]) {
      assert.ok(!offered().includes(writer), `${writer} is not offered for a story`);
    }

    await runAgent(config(engine.baseUrl),
      "Write a JavaScript function unique(arr) that removes duplicates from an array while keeping the original order. Reply with just the code.", context);
    for (const writer of ["write_file", "edit_file"]) assert.ok(!offered().includes(writer), `${writer} is not offered for code in the reply`);

    // The controls: an order that names its file, one that edits, and one
    // about a file the conversation is already on, keep the writers.
    await runAgent(config(engine.baseUrl), "Write a short story about a lighthouse keeper and save it to story.txt", context);
    assert.ok(offered().includes("write_file"), "a named file is an order to write it");
    await runAgent(config(engine.baseUrl), "create notes.txt saying hello", context);
    assert.ok(offered().includes("write_file"));
    await runAgent(config(engine.baseUrl), "add a guard to the greet function", context);
    assert.ok(offered().includes("edit_file"), "an edit with no file named still has the editor");
    await runAgent(config(engine.baseUrl), "write a summary of it at the top", { ...context, impliedFile: "notes.txt" });
    assert.ok(offered().includes("edit_file") || offered().includes("write_file"), "the file the conversation is on can still be written");
  } finally {
    await engine.close();
  }
});

test("a model that reaches for write_file anyway writes nothing, and its story is the reply", async () => {
  // What the 3B did, scripted: the story in a write_file call first.
  const told = "The lamp turned all night, and by morning the storm had gone.";
  const reaching = [
    { message: { content: "", tool_calls: [{ function: { name: "write_file", arguments: { path: "story_lighthouse.txt", content: told } } }] } },
    { message: { content: told } }
  ];

  const engine = await fakeEngine({ reply: reaching });
  try {
    const result = await runAgent(config(engine.baseUrl), story, context);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) return;
    assert.equal(result.text, told, "the story is what the user reads");
    assert.equal(existsSync(path.join(testWorkspace, "story_lighthouse.txt")), false, "no file nobody asked for");
    assert.deepEqual(result.toolsUsed, [], "nothing ran");
    // The story was in the call, and is read out of it rather than asked for a
    // second time: asked again, the 7B has answered with something else
    // entirely (see writing-for-someone.test.ts).
    assert.equal(engine.chats.length, 1);
  } finally {
    await engine.close();
  }

  // The control: the same model, asked to keep the story, does write it.
  const keeping = await fakeEngine({ reply: reaching });
  try {
    const result = await runAgent(config(keeping.baseUrl), "Write a short story about a lighthouse keeper and save it to story_lighthouse.txt", context);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    assert.equal(readFileSync(path.join(testWorkspace, "story_lighthouse.txt"), "utf8"), told);
  } finally {
    await keeping.close();
  }
});
