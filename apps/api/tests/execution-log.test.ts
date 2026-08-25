import test from "node:test";
import assert from "node:assert/strict";
import {
  beginEvent,
  clearEvents,
  endEvent,
  listEvents,
  maxEvents,
  recordEvent,
  resetExecutionLog
} from "../src/services/executionLog.js";

// The trace is a record of what happened, so the thing it must never do is
// claim a step that did not run, or report one as finished while it is still
// going. Everything here is about that.

test.beforeEach(() => resetExecutionLog());
test.after(() => resetExecutionLog());

test("a step in progress is visible as in progress", () => {
  // The difference between "this is taking a while" and "this has stopped"
  // is the entire reason begin and end are separate calls.
  beginEvent("s1", "write", "Writing 9 files");

  const [event] = listEvents("s1");
  assert.equal(event.status, "running");
  assert.equal(event.endedAt, undefined);
  assert.equal(event.durationMs, undefined);
});

test("finishing a step records what actually happened", () => {
  const id = beginEvent("s1", "write", "Writing 9 files");
  endEvent("s1", id, "ok", "9 files", "my-app/");

  const [event] = listEvents("s1");
  assert.equal(event.status, "ok");
  assert.equal(event.detail, "9 files");
  assert.equal(event.artifact, "my-app/");
  assert.ok(event.endedAt);
  assert.ok(typeof event.durationMs === "number" && event.durationMs >= 0);
});

test("duration is measured from the real clock, not estimated", () => {
  const started = new Date(2026, 7, 25, 12, 0, 0);
  const id = beginEvent("s1", "test", "Running checks", started);
  endEvent("s1", id, "ok", undefined, undefined, new Date(started.getTime() + 2500));

  assert.equal(listEvents("s1")[0].durationMs, 2500);
});

test("a failed step is recorded as failed, with its reason", () => {
  const id = beginEvent("s1", "install", "npm install");
  endEvent("s1", id, "failed", "exit code 1: ENOENT");

  const [event] = listEvents("s1");
  assert.equal(event.status, "failed");
  assert.match(event.detail ?? "", /ENOENT/);
});

test("skipped is its own outcome, distinct from passed and failed", () => {
  // "Could not check" is not "checked and fine". Rounding one into the other
  // is exactly the quiet overclaiming this trace exists to prevent.
  recordEvent("s1", "verify", "Running its own checks", "skipped", "npm is not installed");

  const [event] = listEvents("s1");
  assert.equal(event.status, "skipped");
  assert.notEqual(event.status, "ok");
});

test("steps keep the order they happened in", () => {
  recordEvent("s1", "plan", "Planned it", "ok");
  recordEvent("s1", "write", "Wrote files", "ok");
  recordEvent("s1", "verify", "Checked it", "ok");

  assert.deepEqual(listEvents("s1").map((event) => event.kind), ["plan", "write", "verify"]);
});

test("one session's trace is not another's", () => {
  recordEvent("s1", "write", "mine", "ok");
  recordEvent("s2", "write", "theirs", "ok");

  assert.equal(listEvents("s1").length, 1);
  assert.equal(listEvents("s1")[0].label, "mine");
  assert.equal(listEvents("s2")[0].label, "theirs");
});

test("without a session nothing is recorded, and nothing throws", () => {
  // The tools call this unconditionally; a turn with nowhere to file a trace
  // must still do its actual work.
  const id = beginEvent(undefined, "write", "nowhere to record this");
  endEvent(undefined, id, "ok");

  assert.equal(id, null);
  assert.deepEqual(listEvents(undefined), []);
});

test("ending a step that does not exist changes nothing", () => {
  recordEvent("s1", "write", "real", "ok");
  endEvent("s1", "nonsense-id", "failed", "should not appear");

  assert.equal(listEvents("s1").length, 1);
  assert.equal(listEvents("s1")[0].status, "ok");
});

test("clearing a session drops its trace and leaves others alone", () => {
  recordEvent("s1", "write", "mine", "ok");
  recordEvent("s2", "write", "theirs", "ok");
  clearEvents("s1");

  assert.deepEqual(listEvents("s1"), []);
  assert.equal(listEvents("s2").length, 1);
});

test("a long session drops the oldest steps rather than growing forever", () => {
  for (let index = 0; index < maxEvents + 25; index += 1) {
    recordEvent("s1", "command", `step ${index}`, "ok");
  }

  const events = listEvents("s1");
  assert.equal(events.length, maxEvents);
  // What is kept is what just happened, which is what a live trace is for.
  assert.equal(events[events.length - 1].label, `step ${maxEvents + 24}`);
});

test("listing returns copies, so nobody can rewrite what happened", () => {
  recordEvent("s1", "write", "real", "ok");
  const [copy] = listEvents("s1");
  copy.status = "failed";
  copy.label = "rewritten";

  assert.equal(listEvents("s1")[0].status, "ok");
  assert.equal(listEvents("s1")[0].label, "real");
});
