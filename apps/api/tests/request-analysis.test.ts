import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRequest, leadAfterQualifier, narrativeAfterQuestionWord } from "../src/services/requestAnalysis.js";

for (const message of [
  "continue",
  "proceed",
  "resume",
  "go ahead",
  "do it",
  "do that",
  "apply that",
  "make the changes"
]) {
  test(`treats "${message}" as a command`, () => {
    const analysis = analyzeRequest(message);

    assert.equal(analysis.shape, "command");
    assert.equal(analysis.hasRequestMarker, true);
  });
}

// Caught live the day fetch_url was added: "Fetch https://example.com and
// tell me what it says" fell through to "statement" and was acknowledged as
// a fact to remember instead of ever reaching the tool — the same failure
// this file already documents twice for other verbs, for the tool's own name.
for (const message of [
  "Fetch https://example.com and tell me what it says",
  "Visit https://example.com",
  "Browse to https://example.com and summarize it"
]) {
  test(`treats "${message}" as a command, not a statement to remember`, () => {
    const analysis = analyzeRequest(message);

    assert.equal(analysis.shape, "command");
    assert.equal(analysis.hasRequestMarker, true);
  });
}

// The same failure again, from a different direction: not a verb the list was
// missing, but a verb the reader never reached. Caught live while testing
// streaming — "In two sentences, explain what a semaphore is." was answered
// with "Got it, I'll keep that in mind for this conversation." It had been
// read as a statement, something the user was telling the assistant, because
// the first word is "In". The identical request with the qualifier at the end
// was answered properly, which is what gave it away.
for (const message of [
  "In two sentences, explain what a semaphore is.",
  "Briefly, summarise the plan",
  "As a bullet list, show the open tasks",
  "For the record, list every tool you have"
]) {
  test(`reads past the qualifier in "${message}"`, () => {
    assert.equal(analyzeRequest(message).shape, "command");
  });
}

test("moving the qualifier does not change what the request is", () => {
  const front = analyzeRequest("In two sentences, explain what a semaphore is");
  const back = analyzeRequest("Explain what a semaphore is in two sentences");

  assert.equal(front.shape, back.shape);
  assert.equal(front.shape, "command");
});

// The bound is the whole reason this is safe. Without it, any statement
// containing a comma whose second half happens to start with a verb would be
// read as an order — and a statement misread as a command is the mirror of
// the bug above, with the assistant doing work nobody asked for instead of
// filing away work somebody did.
// "When I was setting up the server, I made a note" was excluded here at
// first: it read as a question because it opens with a wh-word, which was a
// separate bug and would have made this test fail for a reason it is not
// about. That bug is fixed below, so it belongs in this list now.
for (const message of [
  "My name is Hank, and I work on TRHAI",
  "The API runs on port 4000, which I set last week",
  "After the deploy finished on Tuesday afternoon, list prices went up",
  "I spent most of yesterday on the parser, and it finally works",
  "When I was setting up the server last week, I made a note about it"
]) {
  test(`keeps "${message}" a statement`, () => {
    assert.equal(analyzeRequest(message).shape, "statement");
  });
}

test("a qualifier in front of a question leaves it a question", () => {
  // The qualifier rule must not outrank the question mark.
  assert.equal(analyzeRequest("In one line, what is TypeScript?").shape, "question");
  assert.equal(analyzeRequest("Briefly, can you explain closures?").shape, "question");
});

test("british spellings are the same verbs", () => {
  // A spelling should not decide whether the assistant does the work.
  for (const verb of ["summarise", "analyse", "optimise", "organise"]) {
    assert.equal(analyzeRequest(`${verb} the deployment notes`).shape, "command", verb);
  }
});

test("the qualifier reader returns the verb, or nothing to act on", () => {
  assert.equal(leadAfterQualifier("In two sentences, explain this"), "explain");
  assert.equal(leadAfterQualifier("Briefly, summarise it"), "summarise");
  // No comma at all, and a comma with nothing after it, are both "no verb here"
  // rather than something to guess from.
  assert.equal(leadAfterQualifier("Explain this plainly"), null);
  assert.equal(leadAfterQualifier("Something,"), null);
  assert.equal(leadAfterQualifier(",leading comma"), null);
});

test("a long leading clause is not treated as a qualifier", () => {
  // Six words before the comma is a sentence, not a preamble.
  assert.equal(
    leadAfterQualifier("When I was setting up the server, list prices went up"),
    null
  );
});

// A wh-word can open a statement as easily as a question. Found while adding
// the qualifier tests above: "When I was setting up the server, I made a note
// about it" was read as a question, so a fact worth keeping got answered
// instead of remembered. I left it out of that commit rather than let it fail
// there for a reason it was not about; this is it fixed.

for (const message of [
  "When I was setting up the server, I made a note about it",
  "What I need is a way to track invoices",
  "Why I did it that way is complicated",
  "What we decided last week was to ship early",
  "How we handle retries is documented in the runbook"
]) {
  test(`reads "${message.slice(0, 40)}…" as something being told, not asked`, () => {
    assert.equal(analyzeRequest(message).shape, "statement");
  });
}

// The other half: an actual question must stay one. What separates them is
// what follows the wh-word — a question inverts to an auxiliary, a narrative
// carries on with its subject.
for (const message of [
  "When did the server go down",
  "What is TypeScript",
  "Where are my notes",
  "How do I run the tests",
  "Who is on call"
]) {
  test(`keeps "${message}" a question`, () => {
    assert.equal(analyzeRequest(message).shape, "question");
  });
}

test("a question mark settles it whatever follows the wh-word", () => {
  // "When I deploy, what should I check?" opens exactly like the narrative
  // cases and is unambiguously a question. The mark outranks the heuristic.
  assert.equal(analyzeRequest("When I deploy, what should I check?").shape, "question");
  assert.equal(analyzeRequest("What I should do next?").shape, "question");
});

test("the narrative check needs a real subject, not just any second word", () => {
  assert.equal(narrativeAfterQuestionWord("when i was setting up"), true);
  assert.equal(narrativeAfterQuestionWord("when did the server"), false);
  // Too short to tell, and not a question word at all.
  assert.equal(narrativeAfterQuestionWord("when i"), false);
  assert.equal(narrativeAfterQuestionWord("the server was down"), false);
});
