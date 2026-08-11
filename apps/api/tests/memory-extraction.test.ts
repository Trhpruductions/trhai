import test from "node:test";
import assert from "node:assert/strict";
import {
  extractMemoryCandidates,
  memoryFingerprint,
  suppressDuplicateMemories
} from "../src/services/memoryExtraction.js";

test("extracts an explicit remember instruction", () => {
  const [candidate] = extractMemoryCandidates("Remember that the staging database resets nightly.");

  assert.equal(candidate.kind, "fact");
  assert.equal(candidate.body, "the staging database resets nightly");
  assert.equal(candidate.rule, "explicit-remember");
  assert.ok(candidate.confidence >= 0.9);
});

test("extracts preferences and dislikes as preference memories", () => {
  const [liked] = extractMemoryCandidates("I prefer TypeScript over JavaScript.");
  const [disliked] = extractMemoryCandidates("I don't like tabs for indentation.");

  assert.equal(liked.kind, "preference");
  assert.equal(liked.body, "prefer TypeScript over JavaScript");
  assert.equal(disliked.kind, "preference");
  assert.equal(disliked.body, "don't like tabs for indentation");
});

test("extracts team conventions as decisions", () => {
  const [candidate] = extractMemoryCandidates("We decided to standardize on Postgres.");

  assert.equal(candidate.kind, "decision");
  assert.equal(candidate.body, "We decided to standardize on Postgres");
});

test("extracts hard constraints", () => {
  const [never] = extractMemoryCandidates("Never deploy on Fridays.");
  const [deadline] = extractMemoryCandidates("The deadline is March 14.");

  assert.equal(never.kind, "constraint");
  assert.equal(never.body, "Never deploy on Fridays");
  assert.equal(deadline.kind, "constraint");
  assert.equal(deadline.body, "The deadline is March 14");
});

test("preserves negation so a memory cannot invert the user's intent", () => {
  // Regression: capturing only the object turned "Never deploy on Fridays" into
  // "deploy on Fridays", which reads as an instruction to do exactly that.
  const [never] = extractMemoryCandidates("Never force push to main.");
  const [dislike] = extractMemoryCandidates("I don't want email notifications.");
  const [neverUse] = extractMemoryCandidates("I never use yarn.");

  assert.match(never.body, /^Never\s/i);
  assert.match(dislike.body, /don'?t want/i);
  assert.match(neverUse.body, /never use/i);
});

test("ignores ordinary requests that contain no memorable claim", () => {
  assert.deepEqual(extractMemoryCandidates("Build me a dashboard with charts"), []);
  assert.deepEqual(extractMemoryCandidates("Can you fix this bug?"), []);
  assert.deepEqual(extractMemoryCandidates("What did we decide?"), []);
});

test("does not match a memory pattern buried mid-sentence", () => {
  // Precision guard: only sentence-initial statements become memories.
  assert.deepEqual(
    extractMemoryCandidates("Ask the team whether we use Postgres before assuming"),
    []
  );
});

test("ignores empty and non-string input", () => {
  assert.deepEqual(extractMemoryCandidates(""), []);
  assert.deepEqual(extractMemoryCandidates("   "), []);
  assert.deepEqual(extractMemoryCandidates(null), []);
  assert.deepEqual(extractMemoryCandidates(undefined), []);
  assert.deepEqual(extractMemoryCandidates(42), []);
});

test("pulls multiple memories from a multi-sentence message", () => {
  const candidates = extractMemoryCandidates(
    "I prefer dark mode. We use pnpm for installs. Never force push to main."
  );

  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((entry) => entry.kind), ["preference", "decision", "constraint"]);
});

test("caps how many memories one message can write", () => {
  const candidates = extractMemoryCandidates(
    "I prefer a. I like b. We use c. Never d. Always e. Remember that f."
  );

  assert.ok(candidates.length <= 3, `expected at most 3, got ${candidates.length}`);
});

test("does not emit the same memory twice from one message", () => {
  const candidates = extractMemoryCandidates("Remember that we ship on Tuesday. Remember that we ship on Tuesday.");

  assert.equal(candidates.length, 1);
});

test("truncates an overlong title on a word boundary", () => {
  const [candidate] = extractMemoryCandidates(
    `Remember that ${"the deployment pipeline requires manual approval from two reviewers".repeat(2)}`
  );

  assert.ok(candidate.title.length <= 64, `title too long: ${candidate.title.length}`);
  assert.match(candidate.title, /\.\.\.$/);
  assert.doesNotMatch(candidate.title, /\s\.\.\.$/);
});

test("fingerprint ignores case, punctuation and spacing", () => {
  assert.equal(
    memoryFingerprint("We use Postgres!"),
    memoryFingerprint("  we   use postgres  ")
  );
});

test("suppresses candidates already present in the store", () => {
  const candidates = extractMemoryCandidates("Remember that we use Postgres.");
  const kept = suppressDuplicateMemories(candidates, ["we use postgres"]);

  assert.deepEqual(kept, []);
});

test("keeps genuinely new candidates alongside existing memories", () => {
  const candidates = extractMemoryCandidates("Remember that we use Redis for caching.");
  const kept = suppressDuplicateMemories(candidates, ["we use postgres"]);

  assert.equal(kept.length, 1);
  assert.match(kept[0].body, /Redis/i);
});

test("suppresses duplicates within a single batch", () => {
  const kept = suppressDuplicateMemories(
    [
      { title: "a", body: "We use Postgres", kind: "decision", confidence: 0.8, rule: "r" },
      { title: "a", body: "we use postgres!", kind: "decision", confidence: 0.8, rule: "r" }
    ],
    []
  );

  assert.equal(kept.length, 1);
});
