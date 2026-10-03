import test from "node:test";
import assert from "node:assert/strict";
import { answerCredit, answeredFromModelAlone, replyProvenance, sourceLabels, sourcesFor, unanswered } from "../src/components/provenance.js";

// A badge saying where an answer came from is a claim about the answer, so
// every case here is the same question: can it credit a source that did not
// contribute?

test("a tool that ran is credited to the right source", () => {
  assert.deepEqual(sourcesFor([{ name: "search_memory", ok: true }]), ["memory"]);
  assert.deepEqual(sourcesFor([{ name: "read_document", ok: true }]), ["documents"]);
  assert.deepEqual(sourcesFor([{ name: "read_file", ok: true }]), ["workspace"]);
  assert.deepEqual(sourcesFor([{ name: "fetch_url", ok: true }]), ["web"]);
  assert.deepEqual(sourcesFor([{ name: "run_command", ok: true }]), ["machine"]);
  assert.deepEqual(sourcesFor([{ name: "build_app", ok: true }]), ["built"]);
});

test("a tool that failed is not credited as a source", () => {
  // The important one. A search that returned nothing did not provide the
  // answer, and badging it implies the reply was checked against something
  // when it was not — worse than showing no badge at all.
  assert.deepEqual(sourcesFor([{ name: "search_memory", ok: false }]), []);
  assert.deepEqual(
    sourcesFor([{ name: "search_memory", ok: false }, { name: "read_file", ok: true }]),
    ["workspace"]
  );
});

test("several tools of one kind collapse to a single badge", () => {
  assert.deepEqual(
    sourcesFor([
      { name: "list_files", ok: true },
      { name: "read_file", ok: true },
      { name: "read_file", ok: true }
    ]),
    ["workspace"]
  );
});

test("badges keep a stable order regardless of the order tools ran", () => {
  // Otherwise the badges under two replies shuffle for no reason the reader
  // can see.
  const one = sourcesFor([
    { name: "run_command", ok: true },
    { name: "search_memory", ok: true },
    { name: "fetch_url", ok: true }
  ]);
  const other = sourcesFor([
    { name: "fetch_url", ok: true },
    { name: "run_command", ok: true },
    { name: "search_memory", ok: true }
  ]);
  assert.deepEqual(one, other);
  assert.deepEqual(one, ["memory", "web", "machine"]);
});

test("an answer with no tools is distinguished from one we were never told about", () => {
  // An empty list means the model answered from itself, which is the single
  // most useful thing to know about a reply. `undefined` means no tool list
  // reached us — a message restored from an earlier session — and must not be
  // labelled unsourced on that account.
  assert.equal(answeredFromModelAlone([]), true);
  assert.equal(answeredFromModelAlone(undefined), false);
  assert.equal(answeredFromModelAlone([{ name: "search_memory", ok: true }]), false);
});

test("every source class has a label and an explanation", () => {
  for (const source of sourcesFor([
    { name: "search_memory", ok: true },
    { name: "read_document", ok: true },
    { name: "read_file", ok: true },
    { name: "fetch_url", ok: true },
    { name: "run_command", ok: true },
    { name: "build_app", ok: true }
  ])) {
    assert.ok(sourceLabels[source]?.label, `${source} has no label`);
    assert.ok(sourceLabels[source]?.hint, `${source} has no explanation`);
  }
});

test("an unrecognised tool credits nothing rather than guessing", () => {
  assert.deepEqual(sourcesFor([{ name: "some_future_tool", ok: true }]), []);
});

// Who actually answered.

test("a real model is named", () => {
  assert.equal(
    answerCredit("generated", "ollama/qwen2.5-coder:7b"),
    "Answered by qwen2.5-coder:7b"
  );
});

test("the deterministic path is not dressed up as a model", () => {
  // The bug this fixes. "general-core-v1" is ModelRouter's label for the
  // composer path, and there is no model by that name - nothing was generated
  // and nothing was loaded. The footer rendered it in the same sentence as a
  // real model, so the reply that never involved one looked identical to the
  // reply that did.
  for (const strategy of [
    "acknowledge", "answer", "capability", "clarify",
    "no-answer", "not-saved", "plan", "smalltalk"
  ]) {
    const credit = answerCredit(strategy, "general-core-v1");
    assert.equal(credit, "Answered directly, without a model", `wrong for ${strategy}`);
    assert.doesNotMatch(credit!, /core-v1/, "the invented name must not reach the screen");
  }
});

test("not knowing is not the same as knowing it was direct", () => {
  // A turn restored from before strategy was stored tells us nothing, so the
  // caller falls back to its own line rather than asserting either.
  assert.equal(answerCredit(undefined, "ollama/qwen2.5-coder:7b"), null);
  assert.equal(answerCredit(undefined, undefined), null);
});

test("a stopped or failed turn claims nothing", () => {
  assert.equal(answerCredit("stopped", "ollama/x"), null);
  assert.equal(answerCredit("error", "ollama/x"), null);
});

test("generated with no model recorded claims nothing", () => {
  assert.equal(answerCredit("generated", undefined), null);
});

// The line under a reply in Chat.

test("the line under a reply in Chat says how it was produced", () => {
  assert.equal(replyProvenance("generated", "ollama/qwen2.5-coder:7b"), "Written by qwen2.5-coder:7b");
  assert.equal(replyProvenance("generated", "ollama/vexora:latest"), "Written by vexora");
  assert.equal(replyProvenance("answer", "memory"), "Quoted from your saved notes");
  assert.equal(replyProvenance("plan", "general-core-v1"), "Answered on this PC");
  assert.equal(replyProvenance(undefined, undefined), null);
});

test("a reply saying why there is no answer is not labelled as an answer", () => {
  // The API's "failed": a model that ran out of time or past its length
  // limit, or an order it could not carry out. It read "Answered on this PC".
  assert.equal(replyProvenance("failed", "memory"), "Not answered");
  assert.equal(replyProvenance("stopped", undefined), "Stopped");
  assert.equal(replyProvenance("error", undefined), null);
  // And it is offered again as "Try again", not "Regenerate": there is no answer to replace.
  for (const strategy of ["failed", "stopped", "error"]) assert.equal(unanswered(strategy), true, strategy);
  for (const strategy of ["generated", "plan", "answer", undefined]) assert.equal(unanswered(strategy), false, String(strategy));
});
