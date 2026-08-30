import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRequest, extractTopics } from "../src/services/requestAnalysis.js";
import { selectRelevantMemories, scoreMemories } from "../src/services/memoryRelevance.js";
import {
  buildCapabilityReply,
  composeReply,
  type ComposerMemory,
  isMultiPartQuestion,
  rememberHasTrailingRequest
} from "../src/services/replyComposer.js";

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

test("project-inspection verbs are commands, not statements", () => {
  // Caught live: "Look inside the calculator project, list its files, then
  // read server.js and tell me whether the arithmetic looks correct" led
  // with a verb none of the original commandVerbs covered, fell through to
  // "statement", and was acknowledged with "Got it, I'll keep that in mind"
  // instead of ever reaching the agent — every tool call in it never ran.
  assert.equal(analyzeRequest("Look inside the calculator project").shape, "command");
  assert.equal(analyzeRequest("Inspect the workspace for problems").shape, "command");
  assert.equal(analyzeRequest("Check whether the server starts").shape, "command");
  assert.equal(analyzeRequest("Read server.js and tell me if it looks right").shape, "command");
  assert.equal(analyzeRequest("Verify the build actually works").shape, "command");
});

test("memory- and calculator-tool verbs are commands, not statements", () => {
  // Caught live: "Calculate 47 times 12" got "Got it — I'll keep that in
  // mind for this conversation" and never touched the calculator tool — the
  // same failure as the inspection verbs above, just for a different set of
  // tools that were never added to commandVerbs either.
  assert.equal(analyzeRequest("Remember that the codename is Aurora").shape, "command");
  assert.equal(analyzeRequest("Forget the fact about the codename").shape, "command");
  assert.equal(analyzeRequest("Pin the fact about the deploy window").shape, "command");
  assert.equal(analyzeRequest("Unpin the note about the old server").shape, "command");
  assert.equal(analyzeRequest("Calculate 47 times 12").shape, "command");
  assert.equal(analyzeRequest("Save this as a document called Notes").shape, "command");
  assert.equal(analyzeRequest("Recall what I told you about the deploy schedule").shape, "command");
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

test("a vague build request is built anyway, with the assumption stated", () => {
  // This used to stop and ask what each record should store. Being asked
  // "what should each one store?" after saying "build a CRM" is the assistant
  // handing the work back, and the answer is nearly always the obvious one —
  // so the question bought a round trip and very little else.
  const reply = composeReply({ mode: "build", message: "Build a CRM", memories: [], history: [] });

  assert.equal(reply.strategy, "plan", "it builds rather than interrogating");
  assert.ok(reply.text.length > 0);
});

test("an assumed spec says what it assumed, rather than guessing quietly", () => {
  // Not asking is only honest if the guess is visible. A wrong assumption
  // should cost one sentence, not be discovered later inside the built app.
  const reply = composeReply({ mode: "build", message: "Build a CRM", memories: [], history: [] });

  assert.match(reply.text, /didn't say|I've built it around|Tell me the fields/i,
    `expected the assumption to be stated, got: ${reply.text}`);
});

test("a request that names its fields is built with no assumption note", () => {
  // Nothing was assumed, so there is nothing to disclose — a note here would
  // be noise on a request that was already complete.
  const reply = composeReply({
    mode: "build",
    message: "Build a customer tracker with email, phone and company",
    memories: [],
    history: []
  });

  assert.equal(reply.strategy, "plan");
  assert.ok(!/didn't say|Tell me the fields/i.test(reply.text),
    `expected no assumption note, got: ${reply.text}`);
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

test("a vague follow-up still builds rather than stalling", () => {
  const first = composeReply({ mode: "build", message: "Build a CRM", memories: [], history: [] });

  const reply = composeReply({
    mode: "build",
    message: "not sure really",
    memories: [],
    history: [
      { role: "user", content: "Build a CRM" },
      { role: "assistant", content: first.text }
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
    assert.match(reply.text, /Remember what you tell me/i);
    assert.match(reply.text, /Knowledge/);
    // Without coaching a magic phrase. Extraction runs on every message, so
    // telling the user to prefix their sentence asks them to do filing the
    // system has already done - and it was their loudest complaint about
    // this app.
    assert.doesNotMatch(reply.text, /start with "remember/i);
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
    assert.match(reply, /Remember what you tell me/i);
    assert.match(reply, /Knowledge/);
    assert.match(reply, /Build a working app/i);
    assert.doesNotMatch(reply, /start with "remember/i);
  }
});

test("the capability reply lists real tool names read from the registry", () => {
  const reply = buildCapabilityReply("ollama/x");

  // Not a claim invented for the reply — these are tool names runTool
  // actually dispatches on, so the reply and the permission gate can never
  // describe a different set of tools to each other.
  assert.match(reply, /search_memory/);
  assert.match(reply, /build_app/);
  assert.match(reply, /forget/);
  assert.match(reply, /fetch_url/);
  // Both of these were once honest disclaimers and are now false. fetch_url is
  // real, and run_command is offered by default since machine access stopped
  // being off-until-armed. A reply still saying it cannot run code would be
  // describing a different app from the one running - which is precisely the
  // dishonesty this test was written to catch, pointed the other way.
  assert.doesNotMatch(reply, /no web or internet access/i);
  assert.doesNotMatch(reply, /no arbitrary code execution/i);
  assert.match(reply, /run_command/);
});

// A capability question, unlike a request to retrieve something, must never
// reach the agent loop at all — see agentLoop.ts's anti-repeat protection for
// the second line of defence when a phrasing this pattern does not recognise
// slips through anyway. These are the exact phrasings from the live failure:
// a capability question was falling through to the model, which then called
// sixteen tools — three of them writes — trying to search its way to an
// answer about itself, including one write_document call that actually
// created a document in response to "what can you do".
test("a realistic, detailed capability question is recognised, not just the short forms", () => {
  const message = "Explain what you can do, what tools you have, what permissions you have, "
    + "what integrations are available, your limitations, and perform capability tests.";
  const reply = composeReply({ mode: "general", message, memories: [], history: [] });

  assert.equal(reply.strategy, "capability");
});

test("each individual clause of the failing message is independently recognised", () => {
  const clauses = [
    "explain what you can do",
    "what tools you have",
    "what permissions you have",
    "your limitations",
    "perform capability tests"
  ];

  for (const clause of clauses) {
    const reply = composeReply({ mode: "general", message: clause, memories: [], history: [] });
    assert.equal(reply.strategy, "capability", `"${clause}" produced ${reply.strategy}`);
  }
});

test("more capability phrasings than the original short list", () => {
  const questions = [
    "What tools do you have?",
    "What permissions do you currently have?",
    "What model are you running?",
    "What are your capabilities?",
    "What are your limitations?",
    "Give me a capability report.",
    "Run a capability audit."
  ];

  for (const question of questions) {
    const reply = composeReply({ mode: "general", message: question, memories: [], history: [] });
    assert.equal(reply.strategy, "capability", `"${question}" produced ${reply.strategy}`);
  }
});

// The other half of the fix: broadening the pattern must not turn genuine
// retrieval, memory, and action requests into capability answers. Every one
// of these needs its own real handling, not a description of what the
// assistant could do in the abstract.
test("broadening capability detection does not swallow real requests", () => {
  const nonCapabilityMessages = [
    "Search my documents for the VEXORA architecture.",
    "What did I tell you about VEXORA yesterday?",
    "Build me a Discord bot.",
    "Run this program.",
    "What time is it?",
    "What is a REST API?"
  ];

  for (const message of nonCapabilityMessages) {
    const reply = composeReply({ mode: "general", message, memories: [], history: [] });
    assert.notEqual(reply.strategy, "capability", `"${message}" was misread as a capability question`);
  }
});

test("remembering a fact is never misread as asking about capabilities", () => {
  const reply = composeReply({
    mode: "general",
    message: "Remember that VEXORA is my AI assistant.",
    memories: [],
    history: []
  });

  assert.notEqual(reply.strategy, "capability");
});

test("creating a file is a tool request, not a capability question", () => {
  const reply = composeReply({
    mode: "general",
    message: "Create a file called test.txt.",
    memories: [],
    history: []
  });

  assert.notEqual(reply.strategy, "capability");
});

test("an earlier instruction is never quoted back as an answer", () => {
  // Found in the rebuilt UI: "In one sentence, what is TypeScript?" was answered
  // with the user's own earlier "Explain what a REST API is in two sentences".
  // Excluding questions was not enough — "Explain ..." is command-shaped.
  const reply = composeReply({
    mode: "general",
    message: "In one sentence, what is TypeScript?",
    memories: [],
    history: [{ role: "user", content: "Explain what a REST API is in two sentences." }]
  });

  assert.doesNotMatch(reply.text, /REST API/);
  assert.equal(reply.groundedOnHistory, 0);
});

test("a statement said earlier is still quotable", () => {
  // The feature next door must survive: facts the user asserted still ground a
  // follow-up, which is the whole point of searching the conversation.
  const reply = composeReply({
    mode: "general",
    message: "why did it fail?",
    memories: [],
    history: [{ role: "user", content: "the deploy failed again" }]
  });

  assert.equal(reply.strategy, "answer");
  assert.match(reply.text, /the deploy failed again/);
});

test("a decisively better document passage outranks a weak memory", () => {
  // Memory used to be an absolute veto: any memory over the threshold returned
  // immediately and the knowledge base was never consulted. Asked for the
  // rollback procedure, "Deploys happen on Fridays." scored 0.321 — barely over
  // the bar — and beat the passage holding the actual procedure at 1.575.
  const reply = composeReply({
    mode: "general",
    message: "What is the rollback procedure for the payments deploy?",
    memories: [{
      id: "m1", title: "Deploy", body: "Deploys happen on Fridays.",
      pinned: false, createdAt: new Date().toISOString()
    }],
    knowledge: [{
      id: "k1", documentId: "d1", documentTitle: "Runbook", title: "Rollback",
      body: "Rollback procedure for the payments deploy: run scripts/rollback.sh with the previous release tag.",
      pinned: false, createdAt: new Date().toISOString()
    }]
  });

  assert.equal(reply.strategy, "answer");
  assert.match(reply.text, /rollback\.sh/);
  assert.deepEqual(reply.groundedOn, ["k1"]);
});

test("a deliberately stated fact still wins a close call", () => {
  // The preference is the point: what the user told you outranks a passage that
  // merely shares vocabulary. Only a decisively better passage displaces it.
  const reply = composeReply({
    mode: "general",
    message: "Which database do we use for billing?",
    memories: [{
      id: "m1", title: "Billing database", body: "The billing database is Postgres 16.",
      pinned: false, createdAt: new Date().toISOString()
    }],
    knowledge: [{
      id: "k1", documentId: "d1", documentTitle: "Notes", title: "Database",
      body: "The billing database is described elsewhere in this document.",
      pinned: false, createdAt: new Date().toISOString()
    }]
  });

  assert.equal(reply.strategy, "answer");
  assert.deepEqual(reply.groundedOn, ["m1"]);
});

test("memory still answers when no document comes close", () => {
  const reply = composeReply({
    mode: "general",
    message: "Which database do we use for billing?",
    memories: [{
      id: "m1", title: "Billing database", body: "The billing database is Postgres 16.",
      pinned: false, createdAt: new Date().toISOString()
    }],
    knowledge: [{
      id: "k1", documentId: "d1", documentTitle: "Runbook", title: "Catering",
      body: "Lunch is ordered on Thursdays from the place on the corner.",
      pinned: false, createdAt: new Date().toISOString()
    }]
  });

  assert.equal(reply.strategy, "answer");
  assert.deepEqual(reply.groundedOn, ["m1"]);
});

test("a two-part question is recognised as asking two things", () => {
  assert.equal(
    isMultiPartQuestion("Which database does my billing run on, and what is today's date?"),
    true
  );
  assert.equal(isMultiPartQuestion("How do I deploy, and when should I?"), true);
});

test("one question with a long subject is not two questions", () => {
  // The distinction that matters: "and" joining a subject is not "and" joining
  // two questions.
  assert.equal(isMultiPartQuestion("What is the difference between TCP and UDP?"), false);
  assert.equal(isMultiPartQuestion("Which database do we use for billing and invoicing?"), false);
  assert.equal(isMultiPartQuestion("Is the deploy done?"), false);
});

test("a grounded answer to a two-part question is flagged as partial", () => {
  // Memory answers the first half; the second half needs a tool. The flag is
  // what lets the caller prefer a model that can answer both.
  const reply = composeReply({
    mode: "general",
    message: "Which database does my billing run on, and what is today's date?",
    memories: [{
      id: "m1", title: "Billing database", body: "The billing database is Postgres 16.",
      pinned: false, createdAt: new Date().toISOString()
    }]
  });

  assert.equal(reply.strategy, "answer");
  assert.equal(reply.partial, true);
  // Still a real answer: with no model to ask, half an answer beats none.
  assert.match(reply.text, /Postgres 16/);
});

test("a grounded answer to a single question is not flagged", () => {
  const reply = composeReply({
    mode: "general",
    message: "Which database does my billing run on?",
    memories: [{
      id: "m1", title: "Billing database", body: "The billing database is Postgres 16.",
      pinned: false, createdAt: new Date().toISOString()
    }]
  });

  assert.equal(reply.strategy, "answer");
  assert.equal(reply.partial, false);
});

test("a trailing request after a remember clause is detected", () => {
  // Caught live: this saved the door code correctly and answered with a bare
  // "Saved." — the trailing "tell me every door code I have saved" was never
  // read at all, because the remember branch returns as soon as it recognises
  // the opening clause.
  assert.equal(
    rememberHasTrailingRequest("Remember that the server room door code is 4471. Then tell me every door code I have saved."),
    true
  );
  assert.equal(rememberHasTrailingRequest("Remember that we standardized on Postgres. What do we use for caching?"), true);
});

test("a plain remember statement has no trailing request", () => {
  assert.equal(rememberHasTrailingRequest("Remember that we standardized on Postgres"), false);
  assert.equal(rememberHasTrailingRequest("Remember that we standardized on Postgres."), false);
  assert.equal(rememberHasTrailingRequest("Remember that my deploy server is rack-4 in the basement."), false);
});

test("a second sentence that is not a request does not count", () => {
  // "It has been that way for years" states something else; it is not a
  // second instruction being dropped.
  assert.equal(
    rememberHasTrailingRequest("Remember that we standardized on Postgres. It has been that way for years."),
    false
  );
});

test("a confirmed save is flagged partial when a trailing request was dropped", () => {
  const reply = composeReply({
    mode: "general",
    message: "Remember that the server room door code is 4471. Then tell me every door code I have saved.",
    memories: [],
    history: [],
    memoryWrite: { available: true, saved: 1, savedBodies: ["the server room door code is 4471"] }
  });

  assert.equal(reply.strategy, "acknowledge");
  assert.equal(reply.partial, true);
  // The acknowledgement itself is still the honest reply to fall back on when
  // there is no model to hand the rest to.
  assert.match(reply.text, /Saved/i);
});

test("an ordinary remember statement is not flagged partial", () => {
  const reply = composeReply({
    mode: "general",
    message: "Remember that we standardized on Postgres",
    memories: [],
    history: [],
    memoryWrite: { available: true, saved: 1, savedBodies: ["we standardized on Postgres"] }
  });

  assert.equal(reply.strategy, "acknowledge");
  assert.equal(reply.partial, false);
});

test("a short answer to a clarifying question is not re-asked for being short", () => {
  // "a CRM" is vague on its own — almost no content words — and would
  // ordinarily be told "I need a bit more to work with". It is not on its own
  // here: it is the answer to a question that was just asked, and judging it
  // in isolation would leave the conversation unable to progress, repeating
  // the same clarifying question forever. Found by inspection while fixing
  // the sibling bug in the statement branch a few lines below this one, which
  // already carried the equivalent guard.
  const reply = composeReply({
    mode: "general",
    message: "a CRM",
    memories: [],
    history: [
      { role: "user", content: "Build me something to help my business." },
      { role: "assistant", content: "Before I build that: what should each record store?" }
    ]
  });

  assert.notEqual(reply.strategy, "clarify");
});

test("the same short message with no clarification pending is still too vague", () => {
  // The fix must not stop this from working at all — only when it is
  // genuinely answering something.
  const reply = composeReply({ mode: "general", message: "a CRM", memories: [], history: [] });

  assert.equal(reply.strategy, "clarify");
});

// The app never asks the user to do its filing.
//
// Facts are extracted from every message on the way in - preferences,
// conventions, constraints, not just sentences opening with "remember". So
// telling someone to prefix their sentence with a magic phrase asks them to do
// work the system has already done. It was the loudest complaint about this
// app, and these cases exist so it cannot come back by accident.

test("no reply ever coaches a magic phrase", () => {
  const nagging = /say "remember|start with "remember|remember that \.\.\.|save it for later|saved for next time|beyond this session/i;

  const messages = [
    "the api runs on port 4000",           // a plain statement
    "thanks, that helps",                  // conversational
    "what can you do",                     // capability
    "what is my staging server called",    // a question with nothing stored
    "remember",                            // the prefix with no fact after it
    "i prefer tabs over spaces"            // a preference
  ];

  for (const message of messages) {
    const reply = composeReply({ mode: "general", message, memories: [], history: [] });
    assert.doesNotMatch(reply.text, nagging, `"${message}" nagged: ${reply.text}`);
  }
});

test("acknowledging a statement is short and does not deflect", () => {
  // What the user actually saw: "Got it — I'll keep that in mind for this
  // conversation. Say \"remember that ...\" if you want me to hold on to it
  // permanently, or tell me what you'd like done with it."
  const reply = composeReply({
    mode: "general", message: "the api runs on port 4000", memories: [], history: []
  });

  assert.equal(reply.strategy, "acknowledge");
  assert.doesNotMatch(reply.text, /keep that in mind|permanently|what you'd like done/i);
  assert.ok(reply.text.length < 40, `too wordy for an acknowledgement: ${reply.text}`);
});

test("a saved statement says so, an unsaved one does not claim it", () => {
  // The confirmation has to track the real write, or it is the same false
  // success this codebase spends most of its effort preventing.
  const saved = composeReply({
    mode: "general", message: "the api runs on port 4000", memories: [], history: [],
    memoryWrite: { available: true, saved: 1, savedBodies: ["the api runs on port 4000"] }
  });
  assert.match(saved.text, /saved/i);

  const notSaved = composeReply({
    mode: "general", message: "the api runs on port 4000", memories: [], history: [],
    memoryWrite: { available: false, saved: 0, savedBodies: [] }
  });
  assert.doesNotMatch(notSaved.text, /saved/i);
});

test("a greeting with a vocative is still a greeting", () => {
  // "hello there" fell through to the vague-request branch and was answered
  // with "I need a bit more to work with. Tell me what you're trying to end up
  // with, and any constraint that matters (stack, deadline, audience)" - the
  // exact strange reply the smalltalk branches exist to prevent.
  for (const greeting of ["hello there", "hi there", "hey there!", "hi again", "hey TRHAI", "hello vexora"]) {
    const reply = composeReply({ mode: "general", message: greeting, memories: [], history: [] });
    assert.equal(reply.strategy, "smalltalk", `"${greeting}" produced ${reply.strategy}`);
    assert.doesNotMatch(reply.text, /bit more to work with/i);
  }
});

test("a greeting attached to a real request stays a request", () => {
  // The line this must not cross. Only a vocative is allowed after the
  // greeting; anything else means they asked for something.
  for (const message of [
    "hi can you build me an app",
    "hey what is the capital of France",
    "hello I need a task tracker"
  ]) {
    const reply = composeReply({ mode: "general", message, memories: [], history: [] });
    assert.notEqual(reply.strategy, "smalltalk", `"${message}" was swallowed as smalltalk`);
  }
});

test("a bare greeting still works", () => {
  for (const greeting of ["hello", "hi", "hey!", "good morning"]) {
    assert.equal(
      composeReply({ mode: "general", message: greeting, memories: [], history: [] }).strategy,
      "smalltalk"
    );
  }
});
