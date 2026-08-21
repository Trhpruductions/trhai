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
