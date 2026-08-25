import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRequest, leadAfterQualifier } from "../src/services/requestAnalysis.js";

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
// "When I was setting up the server, I made a note" is deliberately not in
// this list. It reads as a question, because it opens with a wh-word — which
// is its own pre-existing quirk, unrelated to qualifiers, and putting it here
// would make this test fail for a reason it is not about.
for (const message of [
  "My name is Hank, and I work on TRHAI",
  "The API runs on port 4000, which I set last week",
  "After the deploy finished on Tuesday afternoon, list prices went up",
  "I spent most of yesterday on the parser, and it finally works"
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
