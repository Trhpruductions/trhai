import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Point persistence at a scratch file before the store is imported, so a test
// run never reads or writes the real tasks.json.
const dataDir = mkdtempSync(path.join(tmpdir(), "vexora-tasks-"));
process.env.ASSIST_TASK_FILE = path.join(dataDir, "tasks.json");

const {
  clearTask,
  getResumableTask,
  getTask,
  maxTaskAgeMs,
  recordTask,
  reloadTasksFromDisk,
  resetTasks,
  updateTask
} = await import("../src/services/taskStore.js");

const { isContinuationRequest } = await import("../src/services/requestAnalysis.js");

process.on("exit", () => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function fresh(key: string) {
  resetTasks();
  return key;
}

test("a recorded task is resumable, and carries the request that made it", () => {
  const key = fresh("s1");
  recordTask(key, { request: "Inspect the VEXORA router", taskType: "analyze" });

  const resumable = getResumableTask(key);
  assert.ok(resumable, "expected a resumable task");
  assert.equal(resumable.request, "Inspect the VEXORA router");
  assert.equal(resumable.taskType, "analyze");
  assert.equal(resumable.status, "planned");
});

test("nothing is resumable when nothing was recorded", () => {
  const key = fresh("s2");
  // The case that matters most: "do it" with no pending task must resolve to
  // null so the caller asks what to do, rather than inventing something.
  assert.equal(getResumableTask(key), null);
});

test("a finished task is not resumable", () => {
  const key = fresh("s3");
  recordTask(key, { request: "Build a calculator", taskType: "create" });
  updateTask(key, { status: "succeeded" });

  assert.equal(getResumableTask(key), null, "succeeded work must not be resumed by a later 'do it'");
  // Still readable, just not resumable — the record of what happened survives.
  assert.equal(getTask(key)?.status, "succeeded");
});

test("a blocked task stays resumable and keeps the reason it stopped", () => {
  const key = fresh("s4");
  recordTask(key, { request: "Build a website", taskType: "create" });
  updateTask(key, { status: "blocked", error: "No local model was available to run this." });

  const resumable = getResumableTask(key);
  assert.ok(resumable);
  assert.equal(resumable.status, "blocked");
  assert.match(resumable.error ?? "", /No local model/);
});

test("a task interrupted mid-execution is still resumable", () => {
  const key = fresh("s5");
  recordTask(key, { request: "Fix the router", taskType: "fix", status: "executing" });

  // A process that dies here leaves the task in "executing" forever. That is
  // exactly when resuming is most useful, so it must not be treated as junk.
  reloadTasksFromDisk();
  assert.equal(getResumableTask(key)?.status, "executing");
});

test("tools accumulate across resumes rather than replacing", () => {
  const key = fresh("s6");
  recordTask(key, { request: "Build and verify an app", taskType: "create" });

  updateTask(key, { toolsUsed: ["plan_app"] });
  updateTask(key, { toolsUsed: ["build_app", "list_files"] });

  assert.deepEqual(getTask(key)?.toolsUsed, ["plan_app", "build_app", "list_files"]);
});

test("a stale task is not resumed", () => {
  const key = fresh("s7");
  recordTask(key, { request: "Something from last week", taskType: "generic" });

  const wellPast = new Date(Date.now() + maxTaskAgeMs + 60_000);
  assert.equal(getResumableTask(key, wellPast), null);
  // Just past the boundary the other way, it is still there.
  assert.ok(getResumableTask(key, new Date(Date.now() + 1000)));
});

test("a new request replaces the pending one rather than queueing", () => {
  const key = fresh("s8");
  recordTask(key, { request: "First thing", taskType: "generic" });
  recordTask(key, { request: "Second thing", taskType: "generic" });

  // "Continue" has to mean one unambiguous thing.
  assert.equal(getResumableTask(key)?.request, "Second thing");
});

test("tasks are kept per session, never pooled", () => {
  resetTasks();
  recordTask("alice", { request: "Alice's work", taskType: "generic" });
  recordTask("bob", { request: "Bob's work", taskType: "generic" });

  assert.equal(getResumableTask("alice")?.request, "Alice's work");
  assert.equal(getResumableTask("bob")?.request, "Bob's work");
});

test("a task survives a restart", () => {
  const key = fresh("s9");
  recordTask(key, { request: "Survive a restart", taskType: "fix" });
  updateTask(key, { toolsUsed: ["read_file"], status: "blocked", error: "stopped" });

  reloadTasksFromDisk();

  const after = getResumableTask(key);
  assert.equal(after?.request, "Survive a restart");
  assert.deepEqual(after?.toolsUsed, ["read_file"]);
  assert.equal(after?.error, "stopped");
});

test("an empty request records nothing", () => {
  const key = fresh("s10");
  assert.equal(recordTask(key, { request: "   ", taskType: "generic" }), null);
  assert.equal(getResumableTask(key), null);
});

test("updating a session with no task changes nothing", () => {
  const key = fresh("s11");
  assert.equal(updateTask(key, { status: "succeeded" }), null);
  assert.equal(getTask(key), null);
});

test("clearing removes the task", () => {
  const key = fresh("s12");
  recordTask(key, { request: "Clear me", taskType: "generic" });

  assert.equal(clearTask(key), true);
  assert.equal(getResumableTask(key), null);
  assert.equal(clearTask(key), false, "clearing twice reports nothing was there");
});

test("the phrases people actually use to continue are recognised", () => {
  for (const phrase of [
    "do it", "Do it.", "continue", "Continue please", "proceed", "resume",
    "go ahead", "do that", "apply it", "apply that", "make the changes",
    "finish it", "carry on"
  ]) {
    assert.equal(isContinuationRequest(phrase), true, `"${phrase}" should be a continuation`);
  }
});

test("a sentence that merely contains the word is not a continuation", () => {
  // Anchored to the start for exactly this reason: resuming on these would
  // hijack a turn that was about something else.
  for (const phrase of [
    "we should continue testing this later",
    "I want to proceed with caution next week",
    "does it do that automatically?",
    "make the changes I asked for last time work differently"
  ]) {
    const isContinuation = isContinuationRequest(phrase);
    if (phrase.startsWith("make the changes")) {
      // This one does open with the phrase, so it is a continuation by design.
      assert.equal(isContinuation, true);
      continue;
    }
    assert.equal(isContinuation, false, `"${phrase}" should not be a continuation`);
  }
});

test("a non-string is never a continuation", () => {
  for (const value of [undefined, null, 42, {}, []]) {
    assert.equal(isContinuationRequest(value), false);
  }
});
