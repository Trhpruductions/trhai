import test from "node:test";
import assert from "node:assert/strict";
import { runAssistantOrchestrator } from "../src/services/orchestrator.js";
import { getPendingConfirmation, resetPendingConfirmations } from "../src/services/pendingConfirmation.js";
import { parseForgetRequest } from "../src/services/memoryRequests.js";
import { matchMemories } from "../src/services/factWording.js";

// Forgetting, end to end and without a model. Found live: "forget that my
// printer is on the second floor" reached the model, which called forget
// with an empty fact, was told to fill it in, and answered with a call to
// every tool on offer - the loop built an app called "Forget", rendered a
// video and installed a global npm package, on a request to delete one
// sentence. The flow below never reaches a model at all.

/** A session with some memories and a record of what was actually deleted. */
function session(bodies: string[]) {
  let memories = bodies.map((body, index) => ({ id: `m${index + 1}`, body }));
  const removed: string[] = [];
  const sessionId = `forget-flow-${Math.random().toString(16).slice(2)}`;

  const ask = (userMessage: string) => runAssistantOrchestrator({
    mode: "general",
    userMessage,
    sessionId,
    memoryContext: memories.map((memory) => ({ id: memory.id, title: memory.body, body: memory.body })),
    listMemories: () => memories,
    forgetMemory: (id: string) => {
      removed.push(id);
      memories = memories.filter((memory) => memory.id !== id);
      return true;
    },
    forgetAllMemories: () => {
      const count = memories.length;
      removed.push(...memories.map((memory) => memory.id));
      memories = [];
      return count;
    }
  });

  return { ask, removed, sessionId };
}

test.beforeEach(() => resetPendingConfirmations());

test("a forget names the memory, asks, and deletes only on yes", async () => {
  const { ask, removed, sessionId } = session(["my printer is on the second floor"]);

  const offer = await ask("forget that my printer is on the second floor");
  assert.equal(offer.strategy, "confirm", offer.assistantMessage);
  assert.deepEqual(offer.pendingConfirmation, {
    tool: "forget",
    verb: "Forget this saved memory",
    target: "my printer is on the second floor"
  });
  assert.match(offer.assistantMessage, /say yes/i);
  assert.deepEqual(removed, [], "nothing is deleted before the answer");
  assert.deepEqual(offer.toolsUsed, []);

  const done = await ask("yes");
  assert.match(done.assistantMessage, /Deleted from memory: my printer is on the second floor/);
  assert.deepEqual(removed, ["m1"]);
  assert.equal(getPendingConfirmation(sessionId), null, "an approval is consumed");
});

test("no keeps the memory and withdraws the offer", async () => {
  const { ask, removed, sessionId } = session(["my printer is on the second floor"]);

  await ask("forget my printer");
  assert.ok(getPendingConfirmation(sessionId), "the offer stands");

  const kept = await ask("no, keep it");
  assert.match(kept.assistantMessage, /Kept/);
  assert.deepEqual(removed, []);
  assert.equal(getPendingConfirmation(sessionId), null, "the offer is withdrawn");

  // A later "yes" has nothing to land on.
  await ask("yes");
  assert.deepEqual(removed, []);
});

test("a name that fits several memories deletes nothing and lists them", async () => {
  const { ask, removed, sessionId } = session(["my api port is 8080", "my web port is 3210"]);

  const several = await ask("forget my port");
  assert.equal(several.pendingConfirmation, undefined);
  assert.equal(getPendingConfirmation(sessionId), null);
  assert.match(several.assistantMessage, /Several saved memories match/);
  assert.match(several.assistantMessage, /my api port is 8080/);
  assert.match(several.assistantMessage, /my web port is 3210/);
  assert.deepEqual(removed, []);

  const one = await ask("forget my api port");
  assert.equal(one.pendingConfirmation?.target, "my api port is 8080");
});

test("a name that fits nothing lists what is saved instead", async () => {
  const { ask, removed, sessionId } = session(["my api port is 8080"]);

  const none = await ask("forget my dog's name");
  assert.match(none.assistantMessage, /Nothing saved matches/);
  assert.match(none.assistantMessage, /my api port is 8080/, "what is saved is shown so the user can pick");
  assert.equal(getPendingConfirmation(sessionId), null);
  assert.deepEqual(removed, []);
});

test("forget everything asks once and clears on yes", async () => {
  const { ask, removed } = session(["my api port is 8080", "my web port is 3210"]);

  const offer = await ask("forget everything");
  assert.equal(offer.pendingConfirmation?.target, "all of them");
  assert.match(offer.assistantMessage, /2 of them/);
  assert.deepEqual(removed, []);

  const done = await ask("yes");
  assert.match(done.assistantMessage, /Deleted every saved memory: 2/);
  assert.deepEqual(removed, ["m1", "m2"]);
});

test("with nothing saved there is nothing to forget", async () => {
  const { ask, sessionId } = session([]);
  const reply = await ask("forget my api port");
  assert.match(reply.assistantMessage, /Nothing is saved/);
  assert.equal(getPendingConfirmation(sessionId), null);
});

// ---------------------------------------------------------------------------
// Reading the request.

test("the ways a person asks to forget one thing", () => {
  const cases: Array<[string, string]> = [
    ["forget that my printer is on the second floor", "my printer is on the second floor"],
    ["please forget my api port", "my api port"],
    ["Forget about the printer.", "the printer"],
    ["delete the memory about my printer", "my printer"],
    ["remove my api port from your memory", "my api port"],
    ["forget what I said about the printer", "the printer"],
    ["stop remembering that my port is 8080", "my port is 8080"],
    ["forgte my api port", "my api port"]
  ];
  for (const [message, target] of cases) {
    assert.deepEqual(parseForgetRequest(message), { kind: "one", target }, message);
  }
});

test("the ways a person asks to forget everything", () => {
  for (const message of [
    "forget everything",
    "forget everything you know about me",
    "clear your memory",
    "delete all my memories",
    "wipe your memory"
  ]) {
    assert.deepEqual(parseForgetRequest(message), { kind: "all" }, message);
  }
});

test("sentences that are not a request to forget", () => {
  for (const message of [
    "don't forget to call mom",
    "remember that my port is 8080",
    "forget it",
    "what did I ask you to forget?",
    "never forget that the deploy is on friday",
    "I forget what the port was, can you tell me?"
  ]) {
    assert.equal(parseForgetRequest(message), null, message);
  }
});

test("matching prefers the exact wording, then containment, then the words", () => {
  const memories = [
    { body: "my api port is 8080" },
    { body: "my web port is 3210" },
    { body: "the api key rotates on mondays" }
  ];
  assert.deepEqual(matchMemories("my api port is 8080", memories), { kind: "one", memory: memories[0] });
  assert.deepEqual(matchMemories("my api port", memories), { kind: "one", memory: memories[0] });
  assert.equal(matchMemories("api", memories).kind, "several");
  assert.equal(matchMemories("port", memories).kind, "several");
  assert.equal(matchMemories("my dog", memories).kind, "none");
  assert.equal(matchMemories("", memories).kind, "none");
});
