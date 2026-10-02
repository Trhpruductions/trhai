import test from "node:test";
import assert from "node:assert/strict";
import {
  cadenceFrom, countWork, dueLabel, filterHistory, filterSchedules, formatDuration, formatElapsed, isRunningNow, needsYou, orderSchedules,
  taskPhase, taskTitle, taskTypeLabel, type FinishedTask
} from "../src/lib/taskCenter.js";

// The Task center's wording, ordering and filtering.

const finished = (id: string, status: FinishedTask["status"], request: string, extra: Partial<FinishedTask> = {}): FinishedTask => ({
  id, status, request, taskType: "create", toolsUsed: [], startedAt: "2026-10-02T09:00:00.000Z",
  finishedAt: "2026-10-02T09:01:00.000Z", steps: [], ...extra
});

const history = [
  finished("1", "succeeded", "Build a notes app", { result: "Built notes-app in the workspace.", toolsUsed: ["build_app"] }),
  finished("2", "failed", "Deploy the site", { error: "The disk is full." }),
  finished("3", "interrupted", "Summarise the server logs"),
  finished("4", "blocked", "Write the release notes", { error: "No local model was available to run this." })
];

test("running is what the API measures, never what a stored status claims", () => {
  assert.equal(taskPhase({ status: "executing", running: true }), "running");
  // Left "executing" by a restart: stopped, whatever the store says.
  assert.equal(taskPhase({ status: "executing", running: false }), "stopped");
  assert.equal(taskPhase({ status: "succeeded" }), "done");
  assert.equal(taskPhase({ status: "blocked" }), "blocked");
});

test("a task the history already holds as finished is not running, whatever the last poll said", () => {
  const polled = { id: "t1", status: "executing", running: true, updatedAt: "2026-10-02T09:00:00.000Z" };
  assert.equal(isRunningNow(polled, []), true);
  // Caught live: finished between two polls, it showed as running and as done at once.
  assert.equal(isRunningNow(polled, [finished("t1", "succeeded", "x", { finishedAt: "2026-10-02T09:00:02.000Z" })]), false);
  // A resumed task keeps its id; the entry from the attempt before does not count.
  assert.equal(isRunningNow(polled, [finished("t1", "blocked", "x", { finishedAt: "2026-10-02T08:55:00.000Z" })]), true);
  assert.equal(isRunningNow({ ...polled, running: false }, []), false);
  assert.equal(isRunningNow(null, []), false);
});

test("only work waiting on \"continue\" needs you", () => {
  assert.equal(needsYou({ status: "blocked", running: false, resumable: true }), true);
  assert.equal(needsYou({ status: "executing", running: false, resumable: true }), true);
  assert.equal(needsYou({ status: "executing", running: true, resumable: true }), false, "it is still working");
  assert.equal(needsYou({ status: "failed", running: false, resumable: false }), false, "too old to resume");
  assert.equal(needsYou(null), false);
});

test("a search matches every word, in the request, the result, the error or the tools", () => {
  assert.deepEqual(filterHistory(history, "notes", "all").map((task) => task.id), ["1", "4"]);
  assert.deepEqual(filterHistory(history, "DISK full", "all").map((task) => task.id), ["2"]);
  assert.deepEqual(filterHistory(history, "build_app", "all").map((task) => task.id), ["1"]);
  assert.deepEqual(filterHistory(history, "", "all").map((task) => task.id), ["1", "2", "3", "4"]);
});

test("Done is what succeeded and Failed is everything that did not; neither is a schedule", () => {
  assert.deepEqual(filterHistory(history, "", "done").map((task) => task.id), ["1"]);
  assert.deepEqual(filterHistory(history, "", "failed").map((task) => task.id), ["2", "3", "4"]);
  assert.deepEqual(filterHistory(history, "", "scheduled"), []);
  assert.deepEqual(filterHistory(history, "", "running"), []);
});

test("schedules come running first, then soonest, then paused by name", () => {
  const ordered = orderSchedules([
    { name: "Zebra", enabled: false },
    { name: "Later", enabled: true, nextDueAt: "2026-10-02T12:00:00.000Z" },
    { name: "Alpha", enabled: false },
    { name: "Sooner", enabled: true, nextDueAt: "2026-10-02T10:00:00.000Z" },
    { name: "Now", enabled: true, running: true, nextDueAt: "2026-10-03T10:00:00.000Z" }
  ]);
  assert.deepEqual(ordered.map((schedule) => schedule.name), ["Now", "Sooner", "Later", "Alpha", "Zebra"]);
  assert.deepEqual(filterSchedules(ordered, "zeb").map((schedule) => schedule.name), ["Zebra"]);
});

test("the counts come from the lists they count", () => {
  const schedules = [{ enabled: true, running: true }, { enabled: false }];
  assert.deepEqual(countWork({ status: "executing", running: true }, history, schedules), { running: 2, scheduled: 2, done: 1, failed: 3 });
  assert.deepEqual(countWork(null, [], []), { running: 0, scheduled: 0, done: 0, failed: 0 });
});

test("lengths of time read the way a person says them", () => {
  assert.equal(formatDuration(320), "320ms");
  assert.equal(formatDuration(4280), "4.2s");
  assert.equal(formatDuration(38_900), "38s");
  assert.equal(formatDuration(125_000), "2m 05s");
  assert.equal(formatDuration(3_780_000), "1h 03m");
  assert.equal(formatDuration(Number.NaN), "");
});

test("work in progress counts whole seconds, and under one it has just started", () => {
  // Caught live: a task a moment old read "0ms", as if it had finished instantly.
  assert.equal(formatElapsed(0), "just started");
  assert.equal(formatElapsed(999), "just started");
  assert.equal(formatElapsed(42_700), "42s");
  assert.equal(formatElapsed(125_000), "2m 05s");
});

test("the next run reads as how long until it", () => {
  const now = new Date("2026-10-02T09:00:00.000Z");
  assert.equal(dueLabel("2026-10-02T09:00:20.000Z", now), "due now");
  assert.equal(dueLabel("2026-10-02T09:12:00.000Z", now), "in 12 min");
  assert.equal(dueLabel("2026-10-02T12:05:00.000Z", now), "in 3 h 5 min");
  assert.equal(dueLabel("2026-10-02T11:00:00.000Z", now), "in 2 h");
  assert.equal(dueLabel("2026-10-04T09:00:00.000Z", now), "in 2 days");
  assert.equal(dueLabel(undefined, now), "");
});

test("the form's timing becomes a cadence the API accepts, or nothing", () => {
  assert.deepEqual(cadenceFrom({ kind: "daily", time: "09:30", weekdaysOnly: false }), { kind: "daily", minuteOfDay: 570 });
  assert.deepEqual(cadenceFrom({ kind: "daily", time: "8:05", weekdaysOnly: true }), { kind: "daily", minuteOfDay: 485, weekdaysOnly: true });
  assert.equal(cadenceFrom({ kind: "daily", time: "25:00", weekdaysOnly: false }), null);
  assert.deepEqual(cadenceFrom({ kind: "interval", every: 2, unit: "hours" }), { kind: "interval", minutes: 120 });
  assert.deepEqual(cadenceFrom({ kind: "interval", every: 45, unit: "minutes" }), { kind: "interval", minutes: 45 });
  assert.equal(cadenceFrom({ kind: "interval", every: 0, unit: "minutes" }), null);
  assert.equal(cadenceFrom({ kind: "interval", every: 25, unit: "hours" }), null, "longer than a day is not an interval the scheduler runs");
});

test("titles stay on one line, and the general kind of work goes unlabelled", () => {
  assert.equal(taskTitle("Build me\n  a notes   app"), "Build me a notes app");
  assert.equal(taskTitle("x".repeat(200), 20).length, 20);
  assert.equal(taskTypeLabel("create"), "Build");
  assert.equal(taskTypeLabel("generic"), null);
});
