import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalCapabilityReply, inferLocalIntent } from "../src/localAssistant.js";

test("a plain question is not treated as a build request", () => {
  // The regression: this returned "Build track active. I will convert how much
  // ibuprofen should I take into architecture, stack, milestones, and scaffold
  // outputs." — confident, irrelevant, and silent about the service being down.
  assert.equal(inferLocalIntent("how much ibuprofen should I take"), "question");
  assert.equal(inferLocalIntent("what did we decide about the database?"), "question");
  assert.equal(inferLocalIntent("who owns this project"), "question");
});

test("the offline reply for a question admits it cannot answer", () => {
  const reply = buildLocalCapabilityReply("question", "how much ibuprofen should I take");

  assert.match(reply, /can't reach the assistant service/i);
  assert.doesNotMatch(reply, /track active/i);
  // It must not parrot the question back as though it were a work item.
  assert.doesNotMatch(reply, /ibuprofen/);
});

test("an explicit build verb wins over question shape", () => {
  assert.equal(inferLocalIntent("can you build me an expense tracker?"), "build");
  assert.equal(inferLocalIntent("could you create a dashboard for tickets?"), "build");
});

test("a question about a build is a question, not a build", () => {
  // "why did the build fail?" contains "build" but is asking, not commissioning.
  assert.equal(inferLocalIntent("why did the build fail?"), "question");
  assert.equal(inferLocalIntent("what architecture should we use?"), "question");
  // "how do I build a website" is asking for guidance, not commissioning one.
  assert.equal(inferLocalIntent("how do I build a website?"), "question");
});

test("a bare noun phrase is still a build request", () => {
  // This is what people type into the build box; it has no verb and no question
  // shape, and treating it as unanswerable would break the primary flow.
  assert.equal(inferLocalIntent("expense tracker with amount and date"), "build");
});

test("work-shaped requests keep their specific track", () => {
  assert.equal(inferLocalIntent("fix the stack trace in the parser"), "debug");
  assert.equal(inferLocalIntent("compare postgres and sqlite for this"), "research");
  assert.equal(inferLocalIntent("refactor the typescript client"), "code");
});

test("every intent produces a non-empty reply", () => {
  const intents = ["build", "code", "debug", "research", "plan", "business", "creator", "question"] as const;

  for (const intent of intents) {
    const reply = buildLocalCapabilityReply(intent, "the thing");
    assert.ok(reply.trim().length > 30, `${intent} produced no usable reply`);
  }
});
