import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRequest, extractTopics } from "../src/services/requestAnalysis.js";
import { selectRelevantMemories, scoreMemories } from "../src/services/memoryRelevance.js";
import { buildCapabilityReply, composeReply, type ComposerMemory } from "../src/services/replyComposer.js";

function memory(id: string, title: string, body: string, pinned = false): ComposerMemory {
  return { id, title, body, pinned, createdAt: new Date(2026, 0, 1).toISOString() };
}

const postgres = memory("m1", "Database standard", "We standardized on Postgres for all services");
const fridays = memory("m2", "Deploy policy", "Never deploy on Fridays");

test("classifies questions, commands and statements", () => {
  assert.equal(analyzeRequest("Which database should we use?").shape, "question");
  assert.equal(analyzeRequest("How do I run the tests?").shape, "question");
  assert.equal(analyzeRequest("Build a dashboard for revenue").shape, "command");
  assert.equal(analyzeRequest("We standardized on Postgres").shape, "statement");
});

test("treats a recall phrase without a question mark as a question", () => {
  assert.equal(analyzeRequest("Remind me what our database standard is").shape, "question");
  assert.equal(analyzeRequest("What did we decide about deploys").shape, "question");
});

test("a leading command verb does not override an explicit question", () => {
  // "List" is a command verb, but the question mark makes this a question.
  assert.equal(analyzeRequest("List the options?").shape, "question");
  assert.equal(analyzeRequest("List the options").shape, "command");
});

test("identifies question types", () => {
  assert.equal(analyzeRequest("Why did that fail?").questionType, "reason");
  assert.equal(analyzeRequest("When do we ship?").questionType, "time");
  assert.equal(analyzeRequest("How do we deploy?").questionType, "method");
  assert.equal(analyzeRequest("Should we ship today?").questionType, "confirm");
});

test("normalizes plurals so singular and plural forms match", () => {
  const singular = extractTopics("the reporting service layer");
  const plural = extractTopics("reporting services layers");

  assert.deepEqual(singular, plural);
});

test("classifies a bare imperative starting with an auxiliary as not a question", () => {
  // "Do it" is an order, "Do we ship?" is a question.
  assert.notEqual(analyzeRequest("do it").shape, "question");
  assert.equal(analyzeRequest("Do we ship today?").shape, "question");
});

test("extracts topics without stopwords", () => {
  // Terms come back normalized ("analytics" -> "analytic"), which is fine because
  // queries and memories are normalized the same way before matching.
  const topics = extractTopics("What is the best database for our new analytics service?");

  assert.ok(topics.includes("database"));
  assert.ok(topics.includes("analytic"));
  assert.ok(!topics.includes("the"));
  assert.ok(!topics.includes("what"));
});

test("flags a request with almost no content as vague", () => {
  assert.equal(analyzeRequest("do it").vague, true);
  assert.equal(analyzeRequest("Build a revenue forecasting dashboard").vague, false);
});

test("scores a matching memory above an unrelated one", () => {
  const scored = scoreMemories("which database do we use", [postgres, fridays]);

  assert.equal(scored[0].memory.id, "m1");
  assert.ok(scored[0].matchedTerms.includes("database"));
});

test("connects a category question to a concrete stored answer", () => {
  // Neither title nor body contains the word "database" — this is exactly what a
  // real extracted memory looks like ("Remember that we standardized on Postgres").
  const stack = memory("stack", "we standardized on Postgres", "we standardized on Postgres");
  const matches = selectRelevantMemories("What database should I use?", [stack]);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].memory.id, "stack");
  assert.ok(matches[0].matchedTerms.some((term) => term.includes("~")), "expected an expanded match");
});

test("a more specific question does not retrieve worse than a vague one", () => {
  // Regression: extra content words used to dilute coverage below the threshold,
  // so adding detail to a question made retrieval fail.
  const stack = memory("stack", "we standardized on Postgres", "we standardized on Postgres");

  assert.equal(selectRelevantMemories("What database should I use?", [stack]).length, 1);
  assert.equal(
    selectRelevantMemories("Which database should the new reporting service use?", [stack]).length,
    1
  );
});

test("a literal match outranks an expanded one", () => {
  const literal = memory("lit", "Database standard", "Our database standard is documented");
  const expanded = memory("exp", "Stack note", "We run Postgres in production");
  const scored = scoreMemories("what is our database", [expanded, literal]);

  assert.equal(scored[0].memory.id, "lit");
});

test("a multi-word category is reachable by each of its tokens", () => {
  // "which package manager?" tokenizes to "package" + "manager"; a single
  // "packagemanager" key would never have matched.
  const pnpm = memory("pm", "prefer pnpm", "prefer pnpm");

  assert.equal(selectRelevantMemories("Which package manager do we use?", [pnpm]).length, 1);
});

test("expansion does not connect unrelated concepts", () => {
  const matches = selectRelevantMemories("which editor should I use", [postgres]);

  assert.deepEqual(matches, []);
});

test("selects no memory when nothing is relevant", () => {
  const matches = selectRelevantMemories("what is our refund policy for hardware", [postgres]);

  assert.deepEqual(matches, []);
});

test("answers a question directly from a matching memory", () => {
  const reply = composeReply({
    mode: "general",
    message: "Which database should the new service use?",
    memories: [postgres, fridays],
    history: []
  });

  assert.equal(reply.strategy, "answer");
  assert.deepEqual(reply.groundedOn, ["m1"]);
  assert.match(reply.text, /Postgres/);
  // The old engine echoed the request back; the new one must not.
  assert.doesNotMatch(reply.text, /Operator Request/);
  assert.doesNotMatch(reply.text, /Mission Signals/);
});

test("admits when no stored memory answers the question", () => {
  const reply = composeReply({
    mode: "general",
    message: "What is our refund policy for hardware returns?",
    memories: [postgres],
    history: []
  });

  assert.equal(reply.strategy, "no-answer");
  assert.deepEqual(reply.groundedOn, []);
  assert.match(reply.text, /nothing matched that question/i);
  // Says what it looked through, so "no answer" does not read as "you have nothing".
  assert.match(reply.text, /1 saved memory/i);
  // Must not fabricate an answer out of an unrelated memory.
  assert.doesNotMatch(reply.text, /Postgres/);
});

test("distinguishes an empty memory store from an unmatched one", () => {
  const empty = composeReply({ mode: "general", message: "What database do we use?", memories: [], history: [] });

  assert.match(empty.text, /don't have anything saved/i);
});

test("absorbs a plain fact instead of answering it with a work plan", () => {
  const reply = composeReply({
    mode: "general",
    message: "The API runs on port 4000 in development",
    memories: [],
    history: []
  });

  assert.equal(reply.strategy, "acknowledge");
  assert.doesNotMatch(reply.text, /Clarify the desired end state/);
});

test("still plans when a statement actually asks for work", () => {
  for (const request of [
    "I need a revenue reporting dashboard",
    "Help me prepare the launch checklist",
    "Can you set up the staging environment",
    "Let's design the onboarding flow"
  ]) {
    const reply = composeReply({ mode: "general", message: request, memories: [], history: [] });
    assert.equal(reply.strategy, "plan", `expected a plan for: ${request}`);
  }
});

test("a stated need is a request for work regardless of mode", () => {
  for (const mode of ["code", "general", "business"] as const) {
    const reply = composeReply({
      mode,
      message: "The reporting service needs a database layer",
      memories: [],
      history: []
    });
    assert.equal(reply.strategy, "plan", `expected a plan in ${mode} mode`);
  }
});

test("mode never converts a statement of fact into a work request", () => {
  // The client infers mode from keywords, so "api" alone lands in code mode.
  // That must not turn a fact into a plan — and it used to.
  for (const mode of ["code", "build", "debug", "general"] as const) {
    const reply = composeReply({
      mode,
      message: "The API runs on port 4000 in development",
      memories: [],
      history: []
    });
    assert.equal(reply.strategy, "acknowledge", `expected acknowledge in ${mode} mode`);
  }
});

test("answers from conversation history when nothing is saved", () => {
  // Stated in passing, so no memory rule fired — but it was still said.
  const reply = composeReply({
    mode: "general",
    message: "What port does the API run on?",
    memories: [],
    history: [
      { role: "user", content: "The API runs on port 4000 in development" },
      { role: "assistant", content: "Understood." }
    ]
  });

  assert.equal(reply.strategy, "answer");
  assert.equal(reply.groundedOnHistory, 1);
  assert.deepEqual(reply.groundedOn, []);
  assert.match(reply.text, /port 4000/);
  assert.match(reply.text, /earlier in our conversation/i);
});

test("saved memory takes precedence over conversation history", () => {
  const reply = composeReply({
    mode: "general",
    message: "Which database do we use?",
    memories: [postgres],
    history: [{ role: "user", content: "We were considering MySQL for the database" }]
  });

  assert.equal(reply.strategy, "answer");
  assert.deepEqual(reply.groundedOn, ["m1"]);
  assert.equal(reply.groundedOnHistory, 0);
  assert.match(reply.text, /Postgres/);
});

test("never grounds an answer on the assistant's own earlier reply", () => {
  // Otherwise a guess in one turn hardens into a cited fact in the next.
  const reply = composeReply({
    mode: "general",
    message: "What port does the API run on?",
    memories: [],
    history: [
      { role: "assistant", content: "The API probably runs on port 9999" }
    ]
  });

  assert.equal(reply.strategy, "no-answer");
  assert.equal(reply.groundedOnHistory, 0);
  assert.doesNotMatch(reply.text, /9999/);
});

test("resolves a short follow-up using the previous user turn", () => {
  const reply = composeReply({
    mode: "general",
    message: "What about staging?",
    memories: [],
    history: [
      { role: "user", content: "The production database is Postgres 16 on staging and prod" }
    ]
  });

  assert.equal(reply.strategy, "answer");
  assert.equal(reply.groundedOnHistory, 1);
});

test("carry-over never turns a self-contained question into a circular answer", () => {
  // Regression: a question with its own subject used to absorb the previous turn's
  // text, then "match" that same turn and cite it as the answer.
  const reply = composeReply({
    mode: "general",
    message: "What is our deployment budget?",
    memories: [],
    history: [{ role: "user", content: "The reporting service uses Postgres and Redis" }]
  });

  assert.equal(reply.strategy, "no-answer");
  assert.doesNotMatch(reply.text, /Postgres/);
});

test("history grounding still reports no-answer when nothing matches", () => {
  const reply = composeReply({
    mode: "general",
    message: "What is our refund policy?",
    memories: [],
    history: [{ role: "user", content: "The API runs on port 4000" }]
  });

  assert.equal(reply.strategy, "no-answer");
  assert.equal(reply.groundedOnHistory, 0);
});

test("asks one question instead of building a vague request", () => {
  const reply = composeReply({ mode: "build", message: "Build a CRM", memories: [], history: [] });

  assert.equal(reply.strategy, "clarify-build");
  assert.match(reply.text, /what are the records/i);
});

test("builds straight away when the request is specific enough", () => {
  const reply = composeReply({
    mode: "build",
    message: "Build a customer tracker with email and phone",
    memories: [],
    history: []
  });

  assert.equal(reply.strategy, "plan");
});

test("the clarifying answer is merged with the original request", () => {
  const question = composeReply({
    mode: "build", message: "Build a CRM with a dashboard", memories: [], history: []
  });

  const reply = composeReply({
    mode: "build",
    message: "customers with email, phone and company",
    memories: [],
    history: [
      { role: "user", content: "Build a CRM with a dashboard" },
      { role: "assistant", content: question.text }
    ]
  });

  assert.equal(reply.strategy, "plan");
  assert.match(reply.buildRequest ?? "", /CRM/);
  assert.match(reply.buildRequest ?? "", /dashboard/);
  assert.match(reply.buildRequest ?? "", /email, phone and company/);
});

test("never asks the same question twice in a row", () => {
  // The answer may still be vague; asking again would trap the user in a loop.
  const question = composeReply({ mode: "build", message: "Build a CRM", memories: [], history: [] });

  const reply = composeReply({
    mode: "build",
    message: "not sure really",
    memories: [],
    history: [
      { role: "user", content: "Build a CRM" },
      { role: "assistant", content: question.text }
    ]
  });

  assert.notEqual(reply.strategy, "clarify-build");
});

test("does not interrogate a non-build request", () => {
  // Only create-shaped work produces an app, so only that is worth questioning.
  const reply = composeReply({
    mode: "debug", message: "Fix the flaky checkout test", memories: [], history: []
  });

  assert.equal(reply.strategy, "plan");
});

test("produces a mode-specific plan for a command", () => {
  const debug = composeReply({
    mode: "debug",
    message: "Fix the failing checkout integration test",
    memories: [],
    history: []
  });

  assert.equal(debug.strategy, "plan");
  assert.match(debug.text, /Reproduce the failing checkout integration test/i);
  assert.match(debug.text, /regression test/i);

  const business = composeReply({
    mode: "business",
    message: "Build a pricing page for the enterprise tier",
    memories: [],
    history: []
  });

  assert.match(business.text, /metric that proves it/i);
});

test("a plan carries relevant memory through as constraints", () => {
  const reply = composeReply({
    mode: "code",
    message: "Build the new reporting service database layer",
    memories: [postgres],
    history: []
  });

  assert.equal(reply.strategy, "plan");
  assert.deepEqual(reply.groundedOn, ["m1"]);
  assert.match(reply.text, /Constraints I'm carrying from memory/);
  assert.match(reply.text, /Postgres/);
});

test("asks for clarification instead of planning against nothing", () => {
  const reply = composeReply({ mode: "general", message: "do it", memories: [], history: [] });

  assert.equal(reply.strategy, "clarify");
  assert.match(reply.text, /need a bit more/i);
});

test("acknowledges a remember statement without inventing work", () => {
  const reply = composeReply({
    mode: "general",
    message: "Remember that we standardized on Postgres",
    memories: [],
    history: [],
    memoryWrite: { available: true, saved: 1 }
  });

  assert.equal(reply.strategy, "acknowledge");
  assert.match(reply.text, /Saved/i);
});

test("does not claim a save when there was nowhere to save to", () => {
  // The regression: an anonymous request with no session was told "Saved. I'll
  // use that as context from here on" while nothing was written, so the user
  // walked away believing a fact was stored that had been dropped.
  const reply = composeReply({
    mode: "general",
    message: "Remember that my deploy server is rack-4 in the basement",
    memories: [],
    history: [],
    memoryWrite: { available: false, saved: 0 }
  });

  assert.equal(reply.strategy, "not-saved");
  assert.doesNotMatch(reply.text, /\bSaved\./i);
  assert.match(reply.text, /can't save/i);
  // Tells the user how to make it stick, not just that it failed.
  assert.match(reply.text, /sign in|session id/i);
});

test("does not claim a save when nothing could be extracted", () => {
  const reply = composeReply({
    mode: "general",
    message: "Remember that whatever happens next is probably going to happen again",
    memories: [],
    history: [],
    memoryWrite: { available: true, saved: 0 }
  });

  assert.equal(reply.strategy, "not-saved");
  assert.doesNotMatch(reply.text, /\bSaved\./i);
  assert.match(reply.text, /nothing was saved/i);
});

test("a too-vague remember asks for more instead of confirming a save", () => {
  const reply = composeReply({
    mode: "general",
    message: "Remember that",
    memories: [],
    history: [],
    memoryWrite: { available: true, saved: 0 }
  });

  assert.equal(reply.strategy, "clarify");
  assert.doesNotMatch(reply.text, /\bSaved\./i);
});

test("never claims a save when the caller reported no outcome", () => {
  // Absent evidence is not evidence of a write.
  const reply = composeReply({
    mode: "general",
    message: "Remember that we standardized on Postgres",
    memories: [],
    history: []
  });

  assert.equal(reply.strategy, "not-saved");
  assert.doesNotMatch(reply.text, /\bSaved\./i);
});

test("a pinned memory outranks an unpinned one on an equal match", () => {
  // Same title and body as `postgres`, so the lexical match is identical and the
  // pin boost is the only thing that can decide the order.
  const pinned = memory("pin", "Database standard", "We standardized on Postgres for all services", true);
  const scored = scoreMemories("which database do we use", [postgres, pinned]);

  assert.equal(scored[0].memory.id, "pin");
});

test("never grounds an answer on a memory it did not retrieve", () => {
  const reply = composeReply({
    mode: "general",
    message: "What day should we avoid deploying?",
    memories: [postgres, fridays],
    history: []
  });

  for (const id of reply.groundedOn) {
    assert.ok(["m1", "m2"].includes(id));
  }
  if (reply.strategy === "answer") {
    assert.ok(reply.groundedOn.length > 0);
  }
});

test("an earlier question is never quoted back as an answer", () => {
  // The regression: resolveQuery appends the previous user turn to the query,
  // and searchableHistory then searched that same turn, so it matched itself.
  // "what time is it?" was answered with "how do I center a div in CSS?".
  const reply = composeReply({
    mode: "general",
    message: "what time is it?",
    memories: [],
    history: [
      { role: "user", content: "how do I center a div in CSS?" },
      { role: "assistant", content: "I don't have anything saved that answers that yet." }
    ]
  });

  assert.notEqual(reply.strategy, "answer");
  assert.doesNotMatch(reply.text, /center a div/);
  assert.equal(reply.groundedOnHistory, 0);
});

test("a statement said earlier can still ground a follow-up", () => {
  // The fix must not cost the feature it sits next to: a statement carries
  // information and remains quotable.
  const reply = composeReply({
    mode: "general",
    message: "why did it fail?",
    memories: [],
    history: [{ role: "user", content: "the deploy failed again" }]
  });

  assert.equal(reply.strategy, "answer");
  assert.match(reply.text, /the deploy failed again/);
});

test("a greeting gets a greeting, not a request for a stack and deadline", () => {
  for (const greeting of ["hi", "Hello!", "hey", "good morning"]) {
    const reply = composeReply({ mode: "general", message: greeting, memories: [], history: [] });

    assert.equal(reply.strategy, "smalltalk", `"${greeting}" produced ${reply.strategy}`);
    assert.doesNotMatch(reply.text, /deadline|stack/i);
  }
});

test("thanks and acknowledgements are not treated as work requests", () => {
  assert.equal(composeReply({ mode: "general", message: "thanks!", memories: [], history: [] }).strategy, "smalltalk");
  assert.equal(composeReply({ mode: "general", message: "ok", memories: [], history: [] }).strategy, "smalltalk");
  assert.equal(composeReply({ mode: "general", message: "nevermind", memories: [], history: [] }).strategy, "smalltalk");
});

test("asking what it can do gets an honest capability answer", () => {
  for (const question of ["what can you do?", "hi, what can you do", "who are you?", "help"]) {
    const reply = composeReply({ mode: "general", message: question, memories: [], history: [] });

    assert.equal(reply.strategy, "capability", `"${question}" produced ${reply.strategy}`);
    // It must state the limit rather than let the user find it by being disappointed.
    assert.match(reply.text, /no language model/i);
    // And it must name what actually works.
    assert.match(reply.text, /remember that/i);
    assert.match(reply.text, /Knowledge/);
  }
});

test("the capability answer does not claim knowledge it lacks", () => {
  const reply = composeReply({ mode: "general", message: "what can you do?", memories: [], history: [] });

  assert.doesNotMatch(reply.text, /I know|ask me anything|any question/i);
});

test("the capability reply states which backend is actually answering", () => {
  // Two different true statements. Saying there is no model while one answers
  // would be as wrong as promising one that was never installed.
  const withoutModel = buildCapabilityReply();
  assert.match(withoutModel, /no language model behind me/i);
  assert.match(withoutModel, /Install Ollama/i);

  const withModel = buildCapabilityReply("ollama/llama3.2:latest");
  assert.match(withModel, /ollama\/llama3\.2:latest/);
  assert.doesNotMatch(withModel, /no language model behind me/i);
  // Even with a model, sourcing stays distinguished from generation.
  assert.match(withModel, /quoted with its source/i);
});

test("both capability replies still describe what the app does", () => {
  for (const reply of [buildCapabilityReply(), buildCapabilityReply("ollama/x")]) {
    assert.match(reply, /remember that/i);
    assert.match(reply, /Knowledge/);
    assert.match(reply, /Build a working app/i);
  }
});
