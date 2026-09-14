import test from "node:test";
import assert from "node:assert/strict";
import { extractMemoryCandidates } from "../src/services/memoryExtraction.js";
import { composeReply, rememberHasTrailingRequest, trailingRequest } from "../src/services/replyComposer.js";
import { looksLikeDateMath } from "../src/services/actionIntent.js";
import { availableTools, runTool } from "../src/services/agentTools.js";
import { isLastAskRequest, isListMemoriesRequest, parsePinRequest } from "../src/services/memoryRequests.js";
import { looksLikeClockMath } from "../src/services/actionIntent.js";
import { permissionLevelOf } from "../src/services/toolPermissions.js";
import { shiftClock } from "../src/services/clockMath.js";
import { runAssistantOrchestrator } from "../src/services/orchestrator.js";
import { resetPendingConfirmations } from "../src/services/pendingConfirmation.js";

// Fourth intelligence sweep. Every case was found by asking the running
// assistant and reading the reply; the phrasings are the real ones.

const at = new Date(0).toISOString();
const memory = (id: string, body: string) => ({ id, title: body, body, pinned: false, createdAt: at });

test.beforeEach(() => resetPendingConfirmations());

// ---------------------------------------------------------------------------
// A trailing instruction is not part of the fact.

test("a ', then ...' clause is left out of the remembered fact", () => {
  // Verbatim. Stored whole, and the list was never produced.
  const candidates = extractMemoryCandidates(
    "remember that the server room code is 4471, then list everything you have saved"
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].body, "the server room code is 4471");
});

test("the trailing clause is seen as the request it is", () => {
  assert.equal(
    rememberHasTrailingRequest("remember that the server room code is 4471, then list everything you have saved"),
    true
  );
  // "and" alone joins two halves of one fact.
  assert.equal(rememberHasTrailingRequest("remember that my api port is 8080 and my web port is 3210"), false);
});

// ---------------------------------------------------------------------------
// "what do you know about me" is about the user, not the assistant.

test("a question about the user is not a capability question", () => {
  const memories = [memory("m1", "the server room code is 4471")];
  for (const message of ["what do you know about me?", "what can you tell me about my api port?", "what do you remember about my printer?"]) {
    const reply = composeReply({ mode: "general", message, memories, history: [] });
    assert.notEqual(reply.strategy, "capability", message);
  }
  for (const message of ["what can you do?", "what do you do", "who are you?", "What can you do for me today?"]) {
    const reply = composeReply({ mode: "general", message, memories, history: [] });
    assert.equal(reply.strategy, "capability", message);
  }
});

// ---------------------------------------------------------------------------
// The date tools are only in reach when the question is about dates.

test("time-of-day arithmetic does not get the date tools", () => {
  // Verbatim. shift_date failed twice and the model gave up.
  const train = "if a train leaves at 3pm and the trip takes 2 hours 30 minutes, when does it arrive?";
  assert.equal(looksLikeDateMath(train), false);
  const offered = availableTools(true, { dates: false }).map((definition) => definition.function.name);
  assert.ok(!offered.includes("shift_date"));
  assert.ok(!offered.includes("days_between"));
  assert.ok(offered.includes("current_datetime"), "the clock is always in reach");

  for (const message of ["what date is 90 days from now?", "how many weeks until 2026-12-25?", "how long ago was March 3?", "when is my deadline"]) {
    assert.equal(looksLikeDateMath(message), true, message);
  }
  assert.ok(availableTools(true).map((definition) => definition.function.name).includes("shift_date"));
});

test("shift_date says what it is for when handed hours", async () => {
  const result = await runTool(
    { name: "shift_date", arguments: { from: "today", days: "2 hours 30 minutes" } },
    { memories: [], knowledge: [] }
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /whole number of days/);
  assert.match(result.content, /work the time out yourself/);
});

// ---------------------------------------------------------------------------
// Marking a memory as important.

test("the ways a person asks to mark a memory", () => {
  // The determiner is the pattern's, not the target's.
  assert.deepEqual(parsePinRequest("mark the server room code as important"),
    { target: "server room code", pinned: true, explicit: true });
  assert.deepEqual(parsePinRequest("pin my api port"), { target: "api port", pinned: true, explicit: true });
  assert.deepEqual(parsePinRequest("unpin my api port"), { target: "api port", pinned: false, explicit: true });
  assert.deepEqual(parsePinRequest("mark my api port as not important"),
    { target: "api port", pinned: false, explicit: true });
  assert.deepEqual(parsePinRequest("my family is important to me"), { target: "family", pinned: true, explicit: false });
  assert.deepEqual(parsePinRequest("my api port is no longer important"),
    { target: "api port", pinned: false, explicit: false });
  assert.equal(parsePinRequest("remember that my port is 8080"), null);
  assert.equal(parsePinRequest("pin it"), null);
  assert.equal(parsePinRequest("what is important about the api?"), null);
});

/** A session with some memories and a record of what was actually marked. */
function session(bodies: string[]) {
  const memories = bodies.map((body, index) => ({ id: `m${index + 1}`, body }));
  const marked: Array<[string, boolean]> = [];
  const sessionId = `pin-flow-${Math.random().toString(16).slice(2)}`;
  const ask = (userMessage: string) => runAssistantOrchestrator({
    mode: "general",
    userMessage,
    sessionId,
    memoryContext: memories.map((entry) => ({ id: entry.id, title: entry.body, body: entry.body })),
    listMemories: () => memories,
    pinMemory: (id: string, pinned: boolean) => {
      marked.push([id, pinned]);
      return true;
    }
  });
  return { ask, marked };
}

test("a pin request marks the memory it names, without a model", async () => {
  const { ask, marked } = session(["the server room code is 4471", "my api port is 8080"]);

  // Verbatim. This was answered "Got it." and nothing was marked.
  const pinned = await ask("mark the server room code as important");
  assert.equal(pinned.strategy, "pin", pinned.assistantMessage);
  assert.match(pinned.assistantMessage, /Marked as important: the server room code is 4471/);
  assert.deepEqual(marked, [["m1", true]]);

  const unpinned = await ask("unpin the server room code");
  assert.match(unpinned.assistantMessage, /No longer marked as important: the server room code is 4471/);
  assert.deepEqual(marked, [["m1", true], ["m1", false]]);
});

test("an ambiguous or unmatched pin request marks nothing", async () => {
  const { ask, marked } = session(["my api port is 8080", "my web port is 3210"]);

  const several = await ask("pin my port");
  assert.match(several.assistantMessage, /Several saved memories match/);
  const none = await ask("pin my dog");
  assert.match(none.assistantMessage, /Nothing saved matches "dog"/);
  assert.match(none.assistantMessage, /my api port is 8080/);
  assert.deepEqual(marked, []);
});

// ---------------------------------------------------------------------------
// "delete it" with nothing pending.

test("a bare delete with nothing pending is asked about, not planned", () => {
  // Verbatim. Answered with the build questionnaire: stack, deadline, audience.
  const reply = composeReply({ mode: "general", message: "delete it", memories: [], history: [] });
  assert.equal(reply.strategy, "clarify");
  assert.match(reply.text, /Nothing is pending to delete/);
  assert.doesNotMatch(reply.text, /stack, deadline, audience/);
});

// ---------------------------------------------------------------------------
// Listing what is saved is read from the store, not asked of the model.

test("the ways a person asks what is saved", () => {
  for (const message of [
    "what do you know about me?",
    "list everything you have saved",
    "show me my memories",
    "what have I told you?",
    "What do you remember about me"
  ]) {
    assert.equal(isListMemoriesRequest(message), true, message);
  }
  for (const message of ["what do you know about javascript?", "list the files in D:/x", "remember that my port is 8080"]) {
    assert.equal(isListMemoriesRequest(message), false, message);
  }
});

test("what is saved is listed straight from the store", async () => {
  const memories = [
    { id: "m1", body: "the server room code is 4471", pinned: true },
    { id: "m2", body: "my api port is 8080", pinned: false }
  ];
  const ask = (userMessage: string, list = memories) => runAssistantOrchestrator({
    mode: "general", userMessage, sessionId: "list-flow", listMemories: () => list
  });

  // Verbatim. The model answered "I don't have any specific information
  // about you" with both facts in the session.
  const listed = await ask("what do you know about me?");
  assert.equal(listed.strategy, "list", listed.assistantMessage);
  assert.match(listed.assistantMessage, /\[important\] the server room code is 4471/);
  assert.match(listed.assistantMessage, /my api port is 8080/);
  assert.deepEqual(listed.toolsUsed, []);

  const empty = await ask("list everything you have saved", []);
  assert.match(empty.assistantMessage, /Nothing is saved yet/);
});

// ---------------------------------------------------------------------------
// "what did I just ask you" is about the transcript.

test("the last request is quoted from the transcript, not from memory", async () => {
  for (const message of ["what did I just ask you to do?", "what was my last message?", "what did I say?"]) {
    assert.equal(isLastAskRequest(message), true, message);
  }
  assert.equal(isLastAskRequest("what did I say my port was?"), false, "a recall question stays with memory");

  const history = [
    { role: "user" as const, content: "mark the server room code as important" },
    { role: "assistant" as const, content: "Marked as important: the server room code is 4471" }
  ];
  // Verbatim. Answered "Based on what you've told me: the server room code is 4471".
  const reply = await runAssistantOrchestrator({
    mode: "general", userMessage: "what did I just ask you to do?", sessionId: "recap-flow", history,
    memoryContext: [{ id: "m1", title: "code", body: "the server room code is 4471" }]
  });
  assert.equal(reply.strategy, "recap", reply.assistantMessage);
  assert.match(reply.assistantMessage, /You asked: "mark the server room code as important"/);

  // With the current message echoed at the end of the history, and with none.
  const echoed = await runAssistantOrchestrator({
    mode: "general", userMessage: "what did I just ask you to do?", sessionId: "recap-flow",
    history: [...history, { role: "user" as const, content: "what did I just ask you to do?" }]
  });
  assert.match(echoed.assistantMessage, /mark the server room code as important/);
  const first = await runAssistantOrchestrator({ mode: "general", userMessage: "what did I just ask you?", sessionId: "recap-flow", history: [] });
  assert.match(first.assistantMessage, /first thing/);
});

// ---------------------------------------------------------------------------
// Clock arithmetic is a tool, because the model gets it wrong alone.

test("shift_time does the clock arithmetic the model got wrong", async () => {
  // Verbatim: 3pm plus 2 hours 30 minutes was answered "3:30 PM".
  const arrival = await runTool({ name: "shift_time", arguments: { time: "3pm", hours: 2, minutes: 30 } }, { memories: [], knowledge: [] });
  assert.equal(arrival.ok, true, arrival.content);
  assert.match(arrival.content, /2 hours 30 minutes after 3:00 PM is 5:30 PM\./);

  assert.match(shiftClock("11:45 pm", 0, 30).ok ? (shiftClock("11:45 pm", 0, 30) as { value: string }).value : "", /12:15 AM the next day/);
  assert.match((shiftClock("noon", -1, 0) as { value: string }).value, /1 hour before 12:00 PM is 11:00 AM\./);
  assert.match((shiftClock("15:00", 0, 90) as { value: string }).value, /1 hour 30 minutes after 3:00 PM is 4:30 PM\./);
  assert.match((shiftClock("midnight", 0, -1) as { value: string }).value, /11:59 PM the day before/);
  assert.equal(shiftClock("half past", 1, 0).ok, false);

  assert.equal(permissionLevelOf("shift_time"), 1, "a read, so it never asks for confirmation");
});

test("shift_time is only in reach when a clock time is named", () => {
  assert.equal(looksLikeClockMath("if a train leaves at 3pm and the trip takes 2 hours 30 minutes, when does it arrive?"), true);
  assert.equal(looksLikeClockMath("what date is 90 days from now?"), false);
  assert.equal(looksLikeClockMath("meet me at 15:30"), true);
  const withheld = availableTools(true, { clock: false }).map((definition) => definition.function.name);
  assert.ok(!withheld.includes("shift_time"));
  assert.ok(availableTools(true).map((definition) => definition.function.name).includes("shift_time"));
});

// ---------------------------------------------------------------------------
// "remember X, then list everything you have saved" - both halves, no model.

test("the trailing clause is extracted on its own", () => {
  assert.equal(
    trailingRequest("remember that the server room code is 4471, then list everything you have saved"),
    "list everything you have saved"
  );
  assert.equal(trailingRequest("Remember that the door code is 4471. Then tell me every code I have saved."),
    "tell me every code I have saved.");
  assert.equal(trailingRequest("remember that my api port is 8080"), null);
});

test("a remembered fact followed by a list request answers both halves at once", async () => {
  // Verbatim. Handed the whole sentence with the fact marked as stored, the
  // model called remember again on one run and said "No changes were made."
  // on the next.
  const memories = [{ id: "m1", body: "the server room code is 4471", pinned: false }];
  const reply = await runAssistantOrchestrator({
    mode: "general",
    userMessage: "remember that the server room code is 4471, then list everything you have saved",
    sessionId: "remember-then-list",
    memoryContext: memories.map((memory) => ({ id: memory.id, title: memory.body, body: memory.body })),
    listMemories: () => memories,
    memoryWrite: { available: true, saved: 1, savedBodies: ["the server room code is 4471"] }
  });
  assert.equal(reply.strategy, "acknowledge", reply.assistantMessage);
  assert.match(reply.assistantMessage, /^Saved\./);
  assert.match(reply.assistantMessage, /the server room code is 4471/);
  assert.deepEqual(reply.toolsUsed, []);
});
