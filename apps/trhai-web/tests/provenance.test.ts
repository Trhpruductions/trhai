import test from "node:test";
import assert from "node:assert/strict";
import { answeredFromModelAlone, sourceLabels, sourcesFor } from "../src/components/provenance.js";

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
