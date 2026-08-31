import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runAgent } from "../src/services/agentLoop.js";
import type { LocalModelConfig } from "../src/services/localModel.js";
import type { ToolContext } from "../src/services/agentTools.js";

// An order answered with prose is not an answer.
//
// The loop used to return whatever the model said when it called no tool. So
// "edit greet.js and add a guard" could come back as "Got it, I'll keep that in
// mind for this conversation", and the app presented that as the reply. Nothing
// was edited, nothing failed, and nothing said so.
//
// Every case here is about that: an action request may end in a tool call, one
// specific question, or a truthful failure. Never an acknowledgement.

/** Serves scripted model turns, and records what was sent to it. */
function fakeModel(turns: Array<Record<string, unknown>>) {
  const received: Array<Record<string, unknown>> = [];

  return new Promise<{ server: Server; baseUrl: string; received: typeof received }>((resolve) => {
    let turn = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const body = turns[Math.min(turn, turns.length - 1)];
        turn += 1;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ model: "llama3.2:latest", ...body }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received });
    });
  });
}

const configFor = (baseUrl: string): LocalModelConfig =>
  ({ baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 });

const answer = (content: string) => ({ message: { content } });
const toolCall = (name: string, args: Record<string, unknown>) =>
  ({ message: { content: "", tool_calls: [{ function: { name, arguments: args } }] } });

const context: ToolContext = { memories: [], knowledge: [] };

/** The exact shape of the bug: a polite acknowledgement and no action. */
const acknowledgement = answer("Got it — I'll keep that in mind for this conversation.");

async function ask(question: string, turns: Array<Record<string, unknown>>) {
  const { server, baseUrl, received } = await fakeModel(turns);
  try {
    const result = await runAgent(configFor(baseUrl), question, context);
    return { result, received };
  } finally {
    server.close();
  }
}

const actionRequests: Array<[string, string]> = [
  ["reading a file", "Read D:\\example\\notes.txt"],
  ["listing a folder", "List files in D:\\example"],
  ["editing a file", "Edit D:\\example\\notes.txt and change hello to hi"],
  ["running the tests", "Run npm test in this project"],
  ["building an app", "Build a simple task app"]
];

for (const [label, question] of actionRequests) {
  test(`${label} never ends as a prose acknowledgement`, async () => {
    // Two acknowledgements: the first turn, and the forced retry. Even then the
    // reply must not be the acknowledgement.
    const { result } = await ask(question, [acknowledgement, acknowledgement]);

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.doesNotMatch(result.text, /keep that in mind/i, "the acknowledgement reached the user");
    assert.match(
      result.text,
      /could not perform the requested action|which (?:file|command|project)|what should the app do/i,
      "the failure or the question must be stated plainly"
    );
    assert.equal(result.actionAudit?.actionIntent, true);
  });
}

test("a truthful failure does not imply anything happened", async () => {
  // The one thing this must never do is suggest the work was done.
  const { result } = await ask("Read D:\\example\\notes.txt", [acknowledgement, acknowledgement]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.match(result.text, /No tool was executed during this attempt/i);
  assert.doesNotMatch(result.text, /\bdone\b|\bsuccessfully\b|\bcompleted\b/i);
  assert.equal(result.actionAudit?.outcome, "no-tool-failure");
});

test("the retry happens exactly once, and says why", async () => {
  const { result, received } = await ask(
    "Read D:\\example\\notes.txt",
    [acknowledgement, acknowledgement, acknowledgement]
  );

  // Two generations: the original and one forced retry. Never a third.
  assert.equal(received.length, 2, `expected 2 model calls, got ${received.length}`);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.actionAudit?.forcedRetry, true);

  // The retry has to tell the model what it did wrong, or it just repeats.
  const retryMessages = received[1].messages as Array<{ role: string; content: string }>;
  const last = retryMessages[retryMessages.length - 1];
  assert.equal(last.role, "user");
  assert.match(last.content, /did not call a tool/i);
  assert.match(last.content, /read_file|list_files/);
});

test("a tool call on the retry is honoured, not overridden", async () => {
  // The retry exists to get the action done. When it works, it must work.
  const { result, received } = await ask(
    "Read D:\\example\\notes.txt",
    [acknowledgement, toolCall("read_file", { path: "notes.txt" }), answer("It contains a note.")]
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.toolsUsed.length > 0, true, "the tool should have run");
  assert.equal(result.actionAudit?.forcedRetry, true);
  assert.equal(received.length, 3);
});

test("a request with no file to act on asks one question instead of retrying", async () => {
  // Another generation would arrive at the same place, because the request
  // never named anything. One specific question is the only useful move.
  const { result, received } = await ask("Edit the file and fix the bug", [acknowledgement]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.text, /which file do you mean/i);
  assert.equal(result.actionAudit?.outcome, "clarified");
  assert.equal(result.actionAudit?.forcedRetry, false);
  assert.equal(received.length, 1, "clarifying must not spend a second generation");
});

test("a question is still answered with prose", async () => {
  const { result, received } = await ask(
    "What does this file do?",
    [answer("It exports a greeting helper.")]
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.text, /exports a greeting helper/);
  assert.equal(result.actionAudit?.actionIntent, false);
  assert.equal(received.length, 1, "a question must not trigger a retry");
});

test("an explanation is still answered with prose", async () => {
  const { result } = await ask(
    "Explain TypeScript generics",
    [answer("Generics let a type be written once and used with many types.")]
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.text, /Generics let a type/);
    assert.equal(result.actionAudit?.actionIntent, false);
  }
});

test("an action that ran a tool is left alone entirely", async () => {
  // The enforcement must be invisible when the model behaves.
  const { result, received } = await ask(
    "Read D:\\example\\notes.txt",
    [toolCall("read_file", { path: "notes.txt" }), answer("It contains a note.")]
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.actionAudit?.forcedRetry, false);
  assert.equal(result.actionAudit?.firstTurnToolCalls, 1);
  assert.equal(received.length, 2, "no extra generation when the model calls a tool");
});

test("the audit records what was decided", async () => {
  const { result } = await ask("Build a simple task app", [acknowledgement, acknowledgement]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.actionAudit, {
    kind: "generate",
    actionIntent: true,
    toolActivity: "none",
    firstTurnToolCalls: 0,
    forcedRetry: true,
    outcome: "no-tool-failure"
  });
});

// The terminal message is an absolute claim: "No tool was executed during this
// attempt." These four prove it cannot be said when something did happen.
//
// It is gated on an explicit per-turn state rather than on toolsUsed being
// empty. That inference was sound, but only because a call blocked for
// repeating cannot be blocked until it has already run twice - a property of an
// unrelated constant, which is not what an absolute claim should rest on.

const terminal = /No tool was executed during this attempt/i;

test("the terminal failure is impossible after a tool executed successfully", async () => {
  const { result } = await ask(
    "Read D:\example\notes.txt",
    [toolCall("read_file", { path: "notes.txt" }), acknowledgement, acknowledgement]
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.doesNotMatch(result.text, terminal);
  assert.equal(result.actionAudit?.toolActivity, "executed");
});

test("the terminal failure is impossible after a tool attempt failed", async () => {
  // A tool that ran and failed still ran. Saying otherwise is the false claim
  // this guards against.
  const { result } = await ask(
    "Read D:\example\missing.txt",
    [toolCall("read_file", { path: "does-not-exist-anywhere.txt" }), acknowledgement, acknowledgement]
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.toolsUsed.some((used) => !used.ok), true, "the read should have failed");
  assert.doesNotMatch(result.text, terminal);
  assert.equal(result.actionAudit?.toolActivity, "executed");
});

test("the terminal failure is impossible while a confirmation is pending", async () => {
  // forget is level 3 and unconfirmed here, so the call is held rather than run.
  const { result } = await ask(
    "Delete D:\example\notes.txt",
    [toolCall("forget", { id: "m1" }), acknowledgement, acknowledgement]
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.doesNotMatch(result.text, terminal);
  assert.equal(result.actionAudit?.toolActivity, "awaiting-confirmation");
});

test("the terminal failure is impossible after a policy refusal", async () => {
  // A refusal is a decision the permission system made, not a failure to act,
  // and must never be retried into a claim that nothing was requested.
  const { result, received } = await ask(
    "Delete D:\example\notes.txt",
    [toolCall("forget", { id: "m1" }), acknowledgement]
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.doesNotMatch(result.text, terminal);
  assert.notEqual(result.actionAudit?.toolActivity, "none");
  assert.equal(result.actionAudit?.forcedRetry, false, "a refusal must not trigger the retry");
  assert.equal(received.length, 2);
});

// One specific question, worded for the kind of work.

test("a read with no path asks which file or folder", async () => {
  const { result } = await ask("Read the file for me", [acknowledgement]);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.text, /which file or folder/i);
});

test("an execute with no command asks which command", async () => {
  // Asking "which file?" of someone trying to run something reads as not
  // having understood the request at all.
  const { result } = await ask("Run the script for me", [acknowledgement]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.text, /which command/i);
    assert.doesNotMatch(result.text, /which file/i);
  }
});

test("a check with no project asks which project", async () => {
  const { result } = await ask("Run the tests", [acknowledgement]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.text, /which project/i);
    assert.doesNotMatch(result.text, /which file/i);
  }
});
