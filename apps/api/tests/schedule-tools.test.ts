import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "trhai-sched-"));
const { runTool } = await import("../src/services/agentTools.js");
const { resetSchedules, setSchedulePersistence, listSchedules } =
  await import("../src/services/scheduleStore.js");

setSchedulePersistence(false);
const context = { memories: [], knowledge: [] };

// The app has a scheduler; the assistant could not reach it.
//
// Asked "remind me every day at 9am to check the build" it called no tool and
// explained how to use Windows Task Scheduler. Asked "what schedules do I
// have?" it said "I do not have access to information about your personal
// schedule" - false, they are in this process. Denying a capability the app
// has is the same failure as claiming one it lacks.

test("nothing scheduled says so, rather than denying the feature", async () => {
  resetSchedules();
  const result = await runTool({ name: "list_schedules", arguments: {} }, context);
  assert.equal(result.ok, true);
  assert.match(result.content, /nothing is scheduled/i);
});

test("a daily schedule is saved and listed back", async () => {
  resetSchedules();
  const added = await runTool({
    name: "add_schedule",
    arguments: { name: "Build check", prompt: "check the build", daily_at: "09:00" }
  }, context);

  assert.equal(added.ok, true, added.content);
  assert.match(added.content, /Scheduled "Build check"/);
  assert.equal(listSchedules().length, 1, "it must actually be stored");

  const listed = await runTool({ name: "list_schedules", arguments: {} }, context);
  assert.match(listed.content, /Build check/);
});

test("an interval schedule works too", async () => {
  resetSchedules();
  const added = await runTool({
    name: "add_schedule",
    arguments: { name: "Ping", prompt: "check the site", every_minutes: 30 }
  }, context);
  assert.equal(added.ok, true, added.content);
  assert.equal(listSchedules()[0]?.cadence.kind, "interval");
});

test("a time that is not a time is refused, and nothing is stored", async () => {
  // Reporting the outcome rather than the attempt: "scheduled" for a schedule
  // that was never saved is the false success this codebase is built against.
  resetSchedules();
  const bad = await runTool({
    name: "add_schedule",
    arguments: { name: "Bad", prompt: "x", daily_at: "half past nine" }
  }, context);

  assert.equal(bad.ok, false);
  assert.match(bad.content, /24-hour time/);
  assert.equal(listSchedules().length, 0, "nothing may be stored on a refusal");
});

test("a cadence has to be given at all", async () => {
  resetSchedules();
  const none = await runTool({
    name: "add_schedule", arguments: { name: "Bare", prompt: "x" }
  }, context);
  assert.equal(none.ok, false);
  assert.equal(listSchedules().length, 0);
});
