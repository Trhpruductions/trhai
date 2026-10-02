import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Every stand-in the orchestrator accepts for a machine resource must reach
// the agent loop as well as the orchestrator's own routes. One that does not
// is a test that injects a fake for some paths while the rest quietly read
// the real machine - and passes on any PC that happens to have the real thing.
// It happened twice in one code path: the phone check before a text was held
// (#58), then the vision model behind look_at_image (#62). Each was found by
// accident, so this checks the whole class at once.
//
// A stand-in is an OrchestratorInput field whose comment says the real one is
// used "when absent" - the convention every one of them follows.

const source = readFileSync(new URL("../src/services/orchestrator.ts", import.meta.url), "utf8");

function standIns(text: string): string[] {
  const start = text.indexOf("export type OrchestratorInput = {");
  const block = text.slice(start, text.indexOf("\n};", start));
  const names: string[] = [];
  for (const match of block.matchAll(/\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*(\w+)\?:/g)) {
    if (/when absent/i.test(match[1])) names.push(match[2]);
  }
  return names;
}

/** The stand-ins the agent loop's context is not given. */
function notForwarded(text: string): string[] {
  const start = text.indexOf("await runAgent(");
  const call = text.slice(start, text.indexOf("request: input.userMessage", start));
  return standIns(text).filter((name) => !call.includes(`input.${name}`));
}

test("the stand-ins are found where they are declared", () => {
  // A check that finds nothing passes forever; these three exist today.
  const found = standIns(source);
  for (const name of ["messaging", "vision", "readTelemetry"]) {
    assert.ok(found.includes(name), `${name} was not recognised as a stand-in (found: ${found.join(", ")})`);
  }
});

test("every machine stand-in reaches the agent loop", () => {
  assert.deepEqual(
    notForwarded(source),
    [],
    "these stand-ins reach the orchestrator but not the agent loop, so a test injecting them still reads the real machine from inside the loop"
  );
});

test("the check would catch the omission it was written for", () => {
  // The #62 case: the vision stand-in left out of the loop's context.
  // \r?: a Windows checkout has CRLF line endings, and "." stops at the \r.
  const regressed = source.replace(/^.*\binput\.vision\b.*\r?\n/gm, (line) => (line.includes("vision:") ? "" : line));
  assert.ok(regressed !== source, "the regression fixture did not remove anything");
  assert.deepEqual(notForwarded(regressed), ["vision"]);
});
