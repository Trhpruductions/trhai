import test from "node:test";
import assert from "node:assert/strict";
import { auditDetail, auditVerb, countByKind, filterMemories, howLearned, kindLabel, type MemoryRow } from "../src/lib/memoryLabels.js";

// The Memory workspace's wording and filtering.

const memory = (id: string, kind: MemoryRow["kind"], title: string, body = title, pinned = false): MemoryRow =>
  ({ id, kind, title, body, rule: "explicit-remember", createdAt: "2026-10-01T10:00:00.000Z", pinned });

const list = [
  memory("1", "fact", "Server restarts at 4am", "The DayZ server restarts at 4am every night", true),
  memory("2", "preference", "Prefers dark mode"),
  memory("3", "constraint", "Never delete Discord text"),
  memory("4", "fact", "API port", "The API runs on port 4000")
];

test("search matches every word, in the title or the body, in any order", () => {
  assert.deepEqual(filterMemories(list, "4am server", "all").map((entry) => entry.id), ["1"]);
  assert.deepEqual(filterMemories(list, "PORT", "all").map((entry) => entry.id), ["4"]);
  assert.deepEqual(filterMemories(list, "", "all").map((entry) => entry.id), ["1", "2", "3", "4"]);
  assert.deepEqual(filterMemories(list, "nothing like this", "all"), []);
});

test("a kind narrows the list, and the counts add up", () => {
  assert.deepEqual(filterMemories(list, "", "fact").map((entry) => entry.id), ["1", "4"]);
  assert.deepEqual(filterMemories(list, "port", "preference"), []);
  assert.deepEqual(countByKind(list), { all: 4, fact: 2, preference: 1, decision: 0, constraint: 1 });
});

test("how a memory was learned reads as a sentence, for every rule and an unknown one", () => {
  for (const rule of ["explicit-remember", "explicit-note", "preference", "dislike", "favourite", "team-convention",
    "hard-constraint", "requirement", "profile", "introduction", "named-relation", "something-new"]) {
    const said = howLearned(rule);
    // A sentence - and never a machine name like "explicit-remember" leaking
    // through (a one-word rule such as "favourite" is an ordinary word).
    assert.ok(/^[A-Z]/.test(said) && said.includes(" "), `${rule} -> ${said}`);
    if (rule.includes("-")) assert.ok(!said.includes(rule), `${rule} leaked into "${said}"`);
  }
  assert.equal(kindLabel("constraint"), "Constraint");
  assert.equal(kindLabel("unknown"), "Memory");
});

test("the history reads as verbs, without the store's tracing detail", () => {
  assert.equal(auditVerb("relabeled"), "Renamed");
  assert.equal(auditVerb("cleared"), "Forgot everything");
  assert.equal(auditDetail({ id: "a", memoryId: "1", action: "recorded", detail: "Recorded via explicit-remember: Server restarts at 4am", createdAt: "" }),
    "Server restarts at 4am");
});
