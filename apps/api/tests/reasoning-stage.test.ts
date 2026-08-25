import test from "node:test";
import assert from "node:assert/strict";
import {
  clearStage,
  enterStage,
  finishStages,
  getStage,
  resetStages,
  stageForTool,
  stageLabels
} from "../src/services/reasoningStage.js";

// A stage is a claim about where a request actually is. The thing these tests
// care about most is that it cannot move on its own: a sequence that advanced
// on a timer would look identical to a real one right up until it mattered,
// when a hung request would keep marching confidently through "building" and
// "verifying" while nothing at all was happening.

test.beforeEach(() => resetStages());
test.after(() => resetStages());

test("a session has no stage until something sets one", () => {
  assert.equal(getStage("s1"), null);
});

test("a stage only changes when something changes it", async () => {
  enterStage("s1", "understanding");
  // Time passing is not progress. Nothing here advances the stage, so nothing
  // should have advanced.
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(getStage("s1")?.stage, "understanding");
});

test("entering a stage closes the previous one with its real duration", () => {
  const start = 1_000_000;
  enterStage("s1", "understanding", start);
  enterStage("s1", "gathering", start + 250);

  const record = getStage("s1");
  assert.equal(record?.stage, "gathering");
  assert.deepEqual(record?.completed, [{ stage: "understanding", durationMs: 250 }]);
});

test("re-entering the same stage does not restart or duplicate it", () => {
  // Three searches in a row are one gathering stage that lasted as long as it
  // lasted, not three stages each timed from the last.
  const start = 1_000_000;
  enterStage("s1", "gathering", start);
  enterStage("s1", "gathering", start + 100);
  enterStage("s1", "gathering", start + 200);

  const record = getStage("s1");
  assert.equal(record?.startedAt, start);
  assert.deepEqual(record?.completed, []);
});

test("finishing returns the whole sequence with measured durations", () => {
  const start = 1_000_000;
  enterStage("s1", "understanding", start);
  enterStage("s1", "building", start + 100);
  const sequence = finishStages("s1", start + 400);

  assert.deepEqual(sequence, [
    { stage: "understanding", durationMs: 100 },
    { stage: "building", durationMs: 300 }
  ]);
  // And the turn is over, so there is no current stage left behind.
  assert.equal(getStage("s1"), null);
});

test("finishing a session that never started reports nothing, not a fake stage", () => {
  assert.deepEqual(finishStages("never-ran"), []);
});

test("one session's stage is not another's", () => {
  enterStage("s1", "building");
  enterStage("s2", "gathering");

  assert.equal(getStage("s1")?.stage, "building");
  assert.equal(getStage("s2")?.stage, "gathering");
});

test("without a session nothing is tracked and nothing throws", () => {
  enterStage(undefined, "building");
  assert.equal(getStage(undefined), null);
  assert.deepEqual(finishStages(undefined), []);
});

test("reading a stage hands back a copy of what happened", () => {
  enterStage("s1", "understanding", 1000);
  enterStage("s1", "building", 1100);

  const record = getStage("s1");
  record!.completed.push({ stage: "verifying", durationMs: 9999 });
  record!.stage = "answering";

  assert.equal(getStage("s1")?.stage, "building");
  assert.equal(getStage("s1")?.completed.length, 1);
});

test("clearing drops the stage", () => {
  enterStage("s1", "building");
  clearStage("s1");
  assert.equal(getStage("s1"), null);
});

test("a tool's stage follows what the tool actually does", () => {
  // Derived from the work rather than declared separately, so a new tool
  // cannot be added and quietly report the wrong stage.
  assert.equal(stageForTool("build_app"), "building");
  assert.equal(stageForTool("write_file"), "building");
  assert.equal(stageForTool("run_command"), "building");
  assert.equal(stageForTool("search_memory"), "gathering");
  assert.equal(stageForTool("search_documents"), "gathering");
  assert.equal(stageForTool("list_files"), "gathering");
  assert.equal(stageForTool("read_file"), "gathering");
  assert.equal(stageForTool("fetch_url"), "gathering");
  assert.equal(stageForTool("plan_app"), "planning");
});

test("a tool with no stage of its own is answering, not mislabelled", () => {
  assert.equal(stageForTool("calculate"), "answering");
  assert.equal(stageForTool("current_datetime"), "answering");
  assert.equal(stageForTool("remember"), "answering");
});

test("every stage has a label the interface can show", () => {
  for (const stage of ["understanding", "gathering", "planning", "building", "verifying", "answering"] as const) {
    assert.ok(stageLabels[stage]?.length > 0, `${stage} has no label`);
  }
});
