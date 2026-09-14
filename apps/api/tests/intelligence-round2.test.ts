import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../src/services/actionIntent.js";
import { analyzeRequest } from "../src/services/requestAnalysis.js";
import { normalizeSpelling } from "../src/services/spelling.js";
import { runTool } from "../src/services/agentTools.js";

// Second intelligence sweep. Every case here was found by asking the running
// assistant something and reading the reply; the phrasings are the real ones.

// ---------------------------------------------------------------------------
// A negated order is not an order.

test("an explicitly declined action is not enforced as one", () => {
  // Verbatim. This was classified as a write, the model correctly called no
  // tool, and the enforcement then reported "I could not perform the
  // requested action" - a failure notice for work the user had declined.
  const verdict = classifyIntent(
    "Do NOT create or edit any files. Just tell me in one sentence what a package.json is for."
  );
  assert.equal(verdict.action, false, `read as ${verdict.kind}: ${verdict.reason}`);
});

test("other negations are recognised too", () => {
  for (const message of [
    "without editing anything, tell me what app.ts does",
    "don't delete the config, just show me what is in it",
    "never write to that folder; list what is there instead",
    "no need to create a file, explain the idea"
  ]) {
    const verdict = classifyIntent(message);
    // "show me" / "list" / "explain" may still make these reads; what they must
    // not be is the negated write.
    assert.notEqual(verdict.kind, "write", `${message} -> write`);
  }
});

test("a negation in an earlier clause does not cancel a later order", () => {
  // The window stops at the comma. "Don't just plan" is about planning.
  // ("build me" rather than "build the": the generate phrases are "build
  // a/an/me" - the first version of this test used a phrase the classifier
  // never matched, so the negation window was never exercised at all.)
  const verdict = classifyIntent("don't just plan it, build me a gym tracker app");
  assert.equal(verdict.action, true, verdict.reason);
  assert.equal(verdict.kind, "generate");
});

// ---------------------------------------------------------------------------
// The user's own spelling.

test("known misspellings of the action verbs are corrected", () => {
  assert.equal(normalizeSpelling("buld me a smal app that trakcs my gym visits"),
    "build me a small app that tracks my gym visits");
  assert.equal(normalizeSpelling("plese remeber taht my port is 8080"),
    "please remember that my port is 8080");
});

test("punctuation and unknown words are left alone", () => {
  assert.equal(normalizeSpelling("buld it, creat the file."), "build it, create the file.");
  assert.equal(normalizeSpelling("the bold creak of the door"), "the bold creak of the door");
});

test("a misspelled build request is still a build request", () => {
  // Verbatim. It was answered "Got it." - read as a statement because "buld"
  // matched no verb.
  const message = "buld me a smal app that trakcs my gym visits with date and duration";
  assert.equal(analyzeRequest(message).shape, "command");
  const verdict = classifyIntent(message);
  assert.equal(verdict.action, true);
  assert.equal(verdict.kind, "generate");
});

// ---------------------------------------------------------------------------
// A correction replaces what it corrects.

test("a plain-words correction supersedes the earlier memory", async () => {
  process.env.ASSIST_MEMORY_PERSIST = "off";
  const store = await import(`../src/services/assistMemoryStore.js?round2=${Date.now()}`);
  const session = "round2-correction";
  store.resetAssistMemory();

  store.recordMemoriesFromMessage(session, "remember that my api port is 8080");
  const written = store.recordMemoriesFromMessage(session, "actually correction: my api port is 9090");
  assert.equal(written.length, 1, "the correction must be written at all");

  const bodies = store.listSessionMemories(session).map((entry: { body: string }) => entry.body.toLowerCase());
  assert.ok(bodies.some((body: string) => body.includes("9090")), `9090 missing from ${JSON.stringify(bodies)}`);
  assert.ok(!bodies.some((body: string) => body.includes("8080")), `8080 should be superseded: ${JSON.stringify(bodies)}`);
});

test("a correction with a different subject supersedes nothing", async () => {
  process.env.ASSIST_MEMORY_PERSIST = "off";
  const store = await import(`../src/services/assistMemoryStore.js?round2b=${Date.now()}`);
  const session = "round2-other-subject";
  store.resetAssistMemory();

  store.recordMemoriesFromMessage(session, "remember that my api port is 8080");
  store.recordMemoriesFromMessage(session, "actually, my web port is 3210");

  const bodies = store.listSessionMemories(session).map((entry: { body: string }) => entry.body.toLowerCase());
  assert.ok(bodies.some((body: string) => body.includes("8080")), "the unrelated memory must survive");
  assert.ok(bodies.some((body: string) => body.includes("3210")));
});

// ---------------------------------------------------------------------------
// A confirmation is asked for a call that could actually run.

test("a forget with nothing to forget is refused, not held for confirmation", async () => {
  // "forget my api port" arrived as forget with an empty fact and was held.
  // Had the user said yes, they would have confirmed a call that could only
  // fail. Refused first, the model is told what is missing.
  const result = await runTool(
    { name: "forget", arguments: { fact: "" } },
    { memories: [], knowledge: [] }
  );
  assert.equal(result.ok, false);
  assert.ok(!result.needsConfirmation, "must not be held for confirmation");
  // The refusal is read by the model as its next instruction. "Say exactly
  // what it should apply to" made it state the fact - through remember, in
  // reply to a request to delete it. So the refusal names the tool and the
  // argument and says to call the same tool again.
  assert.match(result.content, /call forget again with fact/i, result.content);
  assert.match(result.content, /do not switch to a different tool/i);
  assert.doesNotMatch(result.content, /say exactly/i);
});

// ---------------------------------------------------------------------------
// A message is a statement only if every sentence is.

test("a request in the second sentence is not a statement", () => {
  // Verbatim. The first word is "do", no "?", so this was a statement and the
  // composer said "Got it." to a request for an explanation.
  const shape = analyzeRequest(
    "Do NOT create or edit any files. Just tell me in one sentence what a package.json is for."
  ).shape;
  assert.notEqual(shape, "statement");
});

test("two plain sentences are still a statement", () => {
  assert.equal(analyzeRequest("My api runs on port 4000. It uses postgres.").shape, "statement");
});

test("a version number is not a sentence boundary", () => {
  // "v2.3" must not split into "v2" and "3", or the second half is checked as
  // a sentence of its own.
  assert.equal(analyzeRequest("We standardised on node v2.3 for the build.").shape, "statement");
});

// ---------------------------------------------------------------------------
// A folder is the one place the user's spelling is corrected.

test("a built app is not named after a misspelling", async () => {
  const { deriveTitle } = await import("@ascend/shared");
  const title = deriveTitle(normalizeSpelling("buld me a smal app that trakcs my gym visits"));
  assert.doesNotMatch(title, /buld|smal|trakcs/i, `title was ${title}`);
  assert.match(title, /gym/i, `the subject should survive: ${title}`);
});

test("a forget with a real target is still held for confirmation", async () => {
  const result = await runTool(
    { name: "forget", arguments: { fact: "my api port is 8080" } },
    { memories: [], knowledge: [] }
  );
  assert.equal(result.ok, false);
  assert.equal(result.needsConfirmation, true);
});
