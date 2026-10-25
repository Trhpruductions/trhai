import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent } from "../src/services/agentLoop.js";
import type { ToolContext } from "../src/services/agentTools.js";
import type { LocalModelConfig } from "../src/services/localModel.js";
import { extractDocumentText } from "../src/services/documentText.js";
import { fakeEngine, type ScriptedReply } from "./helpers/fakeEngine.js";

// Through the whole loop, with a stand-in for the model: asked for a Word file, the assistant is offered the
// tool, makes the file, and what the user is told is where it really is - whatever the model says afterwards.
// Asked for words only, the tool is not in reach, and no file is made.

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-document-loop-"));
process.env.ASCEND_WORKSPACE = workspace;
test.after(() => rmSync(workspace, { recursive: true, force: true }));

const context: ToolContext = { memories: [], knowledge: [] };
const notes = "# Meeting Notes\n\n- Budget approved\n- Hiring paused\n\nNext meeting on Friday.";

async function run(question: string, replies: ScriptedReply[]) {
  const engine = await fakeEngine({ models: ["llama3.1-8b"], reply: replies });
  const config: LocalModelConfig = { baseUrl: engine.baseUrl, model: "llama3.1:8b", modelFromEnv: true, timeoutMs: 5000 };
  try {
    return await runAgent(config, question, context);
  } finally {
    engine.server.close();
  }
}

test("asked for a Word file, the assistant makes it and the user is told where it is, whatever the model goes on to say", async () => {
  const result = await run("Make me a Word document of the meeting notes: budget approved, hiring paused, next meeting Friday.", [
    { message: { content: "", tool_calls: [{ function: { name: "make_document", arguments: { title: "Meeting Notes", content: notes } } }] } },
    { message: { content: "All done! I saved it as meeting-notes.docx on your Desktop." } }
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.toolsUsed.map((used) => used.name), ["make_document"]);
  assert.match(result.text, /documents\/Meeting Notes\.docx \(Word document\)/, "the real place is in the answer");
  assert.match(result.text, /read each file back to check it/);
  const file = path.join(workspace, "documents", "Meeting Notes.docx");
  assert.equal(existsSync(file), true);
  const read = await extractDocumentText(readFileSync(file), "Meeting Notes.docx");
  assert.ok(read.ok && /Hiring paused/.test(read.text) && /Next meeting on Friday\./.test(read.text));
});

test("asked only for words, the tool is out of reach: the call is refused, nothing is made, and no file is claimed", async () => {
  const before = existsSync(path.join(workspace, "documents", "Cover Letter.docx"));
  const result = await run("write me a short cover letter for a barista job", [
    { message: { content: "", tool_calls: [{ function: { name: "make_document", arguments: { title: "Cover Letter", content: "# Cover Letter\n\nDear hiring manager, I love coffee." } } }] } },
    { message: { content: "Dear hiring manager, I would love to work as a barista at your cafe. I have always loved coffee." } }
  ]);
  assert.equal(before, false);
  assert.equal(existsSync(path.join(workspace, "documents", "Cover Letter.docx")), false, "a letter asked for in words is not saved as a file");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.toolsUsed.filter((used) => used.name === "make_document"), [], "the tool did not run");
    assert.doesNotMatch(result.text, /documents\//);
    assert.match(result.text, /Dear hiring manager/);
  }
});
