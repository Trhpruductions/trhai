import test from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/services/agentTools.js";
import { composeReply } from "../src/services/replyComposer.js";
import { contentWords, normalizeFact, statesFact, subjectOf } from "../src/services/factWording.js";
import type { ScorableMemory } from "../src/services/memoryRelevance.js";

// Third intelligence sweep: forgetting. Every case was found by asking the
// running assistant to remember something, then to forget it, then what it
// was - and reading the reply.

const memory = (id: string, body: string): ScorableMemory => ({
  id,
  title: body,
  body,
  pinned: false,
  createdAt: new Date(0).toISOString()
});

/** A confirmed forget, with what it actually removed. */
async function forget(memories: ScorableMemory[], fact: string) {
  const removed: string[] = [];
  const result = await runTool(
    { name: "forget", arguments: { fact } },
    {
      memories,
      knowledge: [],
      forgetMemory: (id: string) => {
        removed.push(id);
        return true;
      },
      confirmedActions: new Set(["forget"])
    }
  );
  return { result, removed };
}

// ---------------------------------------------------------------------------
// The model repeats the user's words back, not the stored wording.

test("the user's own 'that' does not stop a confirmed forget", async () => {
  // Verbatim. "forget that my printer is on the second floor" arrived as
  // forget with the fact "that my printer is on the second floor"; matched
  // literally against the stored body it was not found, and the deletion
  // the user had just confirmed did nothing.
  const { result, removed } = await forget(
    [memory("m1", "my printer is on the second floor")],
    "that my printer is on the second floor"
  );
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /Deleted from memory: my printer is on the second floor/);
  assert.deepEqual(removed, ["m1"]);
});

test("a memory is forgotten by its subject alone", async () => {
  const { result, removed } = await forget([memory("m1", "my api port is 8080")], "my api port");
  assert.equal(result.ok, true, result.content);
  assert.deepEqual(removed, ["m1"]);
});

test("a different determiner still names the same memory", async () => {
  // "forget my api port" was held with the fact "the api port".
  const { result, removed } = await forget([memory("m1", "my api port is 8080")], "the api port");
  assert.equal(result.ok, true, result.content);
  assert.deepEqual(removed, ["m1"]);
});

test("a name that fits several memories deletes nothing and lists them", async () => {
  const { result, removed } = await forget(
    [memory("m1", "my api port is 8080"), memory("m2", "my web port is 3210")],
    "my port"
  );
  assert.equal(result.ok, false);
  assert.deepEqual(removed, [], "a guess must not be deleted");
  assert.match(result.content, /Several saved memories match/);
  assert.match(result.content, /my api port is 8080/);
  assert.match(result.content, /my web port is 3210/);
  assert.match(result.content, /Call forget again/);
});

test("a name that fits nothing deletes nothing", async () => {
  const { result, removed } = await forget([memory("m1", "my api port is 8080")], "my dog's name");
  assert.equal(result.ok, false);
  assert.deepEqual(removed, []);
  assert.match(result.content, /Nothing saved matches/);
});

// ---------------------------------------------------------------------------
// The wording helpers themselves.

test("a fact is reduced to its wording", () => {
  assert.equal(normalizeFact("\"That my printer is on the second floor.\""), "my printer is on the second floor");
  assert.equal(normalizeFact("the fact that my api port is 9090"), "my api port is 9090");
  assert.equal(normalizeFact("  My   API port is 9090 "), "my api port is 9090");
  assert.equal(subjectOf("My API port is 9090"), "my api port");
  assert.equal(subjectOf("just a note"), null);
  assert.deepEqual(contentWords("the api port"), ["api", "port"]);
});

test("a text states a fact by wording or by giving its subject a value", () => {
  assert.equal(statesFact("actually correction: my api port is 9090", "my api port is 9090"), true);
  assert.equal(statesFact("my api port is 8080", "my api port is 9090"), true, "same subject, older value");
  assert.equal(statesFact("my web port is 3210", "my api port is 9090"), false);
  assert.equal(statesFact("what is my api port?", "my api port is 9090"), false);
});

// ---------------------------------------------------------------------------
// Forgotten means not quoted from anywhere.

test("a forgotten fact is not quoted back from the transcript", () => {
  // Verbatim. "forget my api port" deleted the memory, and "what is my api
  // port?" answered "You mentioned this earlier in our conversation: actually
  // correction: my api port is 9090".
  const history = [
    { role: "user" as const, content: "my api port is 8080" },
    { role: "assistant" as const, content: "Got it." },
    { role: "user" as const, content: "actually correction: my api port is 9090" },
    { role: "assistant" as const, content: "Got it." }
  ];

  // Without the forget, the transcript answers - so the case below is not
  // passing for want of a matching turn.
  const before = composeReply({ mode: "general", message: "what is my api port?", memories: [], history });
  assert.ok((before.groundedOnHistory ?? 0) > 0, before.text);
  assert.match(before.text, /9090/);

  const after = composeReply({
    mode: "general",
    message: "what is my api port?",
    memories: [],
    history,
    forgottenFacts: ["my api port is 9090"]
  });
  assert.doesNotMatch(after.text, /9090/, after.text);
  assert.doesNotMatch(after.text, /8080/, "the older value of the same fact is forgotten with it");
  assert.equal(after.groundedOnHistory ?? 0, 0, after.text);
});

test("asking to forget is recorded until the fact is stated again", async () => {
  process.env.ASSIST_MEMORY_PERSIST = "off";
  const store = await import(`../src/services/assistMemoryStore.js?round3=${Date.now()}`);
  const session = "round3-forgotten";
  store.resetAssistMemory();

  store.recordMemoriesFromMessage(session, "remember that my api port is 9090");
  const [saved] = store.listSessionMemories(session);
  assert.ok(saved, "the memory must be written first");
  assert.equal(store.forgetMemory(session, saved.id), true);

  const forgotten = store.listForgottenFacts(session);
  assert.equal(forgotten.length, 1, JSON.stringify(forgotten));
  assert.match(forgotten[0], /9090/);

  // Stated again, with a new value: the user wants it kept after all.
  store.recordMemoriesFromMessage(session, "remember that my api port is 8080");
  assert.deepEqual(store.listForgottenFacts(session), []);
});

test("clearing every memory forgets each of them", async () => {
  process.env.ASSIST_MEMORY_PERSIST = "off";
  const store = await import(`../src/services/assistMemoryStore.js?round3b=${Date.now()}`);
  const session = "round3-cleared";
  store.resetAssistMemory();

  store.recordMemoriesFromMessage(session, "remember that my api port is 9090");
  store.recordMemoriesFromMessage(session, "remember that my printer is on the second floor");
  assert.equal(store.forgetAllMemories(session), 2);

  const forgotten = store.listForgottenFacts(session).join(" | ");
  assert.match(forgotten, /9090/);
  assert.match(forgotten, /second floor/);
});

// ---------------------------------------------------------------------------
// An answer to an offer is not a fact.

test("declining an offer is not saved as a memory", async () => {
  // Verbatim. "forget my printer" made the offer, "no, keep it" declined it -
  // and the session then held a memory whose body was "keep it", because
  // "no," is also how a correction opens.
  process.env.ASSIST_MEMORY_PERSIST = "off";
  const store = await import(`../src/services/assistMemoryStore.js?round3c=${Date.now()}`);
  const session = "round3-decline";
  store.resetAssistMemory();

  store.recordMemoriesFromMessage(session, "remember that my printer is on the second floor");
  const written = store.recordMemoriesFromMessage(session, "no, keep it");
  assert.deepEqual(written, []);
  const bodies = store.listSessionMemories(session).map((entry: { body: string }) => entry.body);
  assert.deepEqual(bodies, ["my printer is on the second floor"]);

  // A correction that states a fact still corrects.
  store.recordMemoriesFromMessage(session, "remember that my api port is 8080");
  store.recordMemoriesFromMessage(session, "no, my api port is 9090");
  const after = store.listSessionMemories(session).map((entry: { body: string }) => entry.body.toLowerCase());
  assert.ok(after.some((body: string) => body.includes("9090")), JSON.stringify(after));
  assert.ok(!after.some((body: string) => body.includes("8080")), JSON.stringify(after));
});
