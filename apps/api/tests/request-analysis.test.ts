import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRequest } from "../src/services/requestAnalysis.js";

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
