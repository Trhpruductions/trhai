import test from "node:test";
import assert from "node:assert/strict";
import { newRuns, type ScheduleRun } from "../src/lib/reminders.js";

const water = (lastRunAt: string | null, lastStatus: string | null = "ok", lastDetail: string | null = "Drink water"): ScheduleRun =>
  ({ id: "water", name: "Drink water", lastRunAt, lastStatus, lastDetail });

test("runs from before the app opened are history: the first look shows nothing", () => {
  const { fresh, next } = newRuns(null, [water("2026-10-01T14:15:00.000Z")]);
  assert.deepEqual(fresh, []);
  assert.equal(next.get("water"), "2026-10-01T14:15:00.000Z");
});

test("a run since the last look is a reminder, once", () => {
  const first = newRuns(null, [water("2026-10-01T14:15:00.000Z")]);
  const fired = newRuns(first.next, [water("2026-10-02T14:15:00.000Z")]);
  assert.deepEqual(fired.fresh, [{ key: "water@2026-10-02T14:15:00.000Z", title: "Drink water", body: "Drink water", failed: false }]);
  assert.deepEqual(newRuns(fired.next, [water("2026-10-02T14:15:00.000Z")]).fresh, [], "the same run is not shown twice");
});

test("a schedule made after the app opened reminds on its first run", () => {
  const before = newRuns(null, []);
  const made = newRuns(before.next, [water(null, null, null)]);
  assert.deepEqual(made.fresh, [], "made, not yet run");
  const ran = newRuns(made.next, [water("2026-10-02T14:15:00.000Z")]);
  assert.equal(ran.fresh.length, 1);
});

test("a failed run says so; anything that did not run is not news", () => {
  const first = newRuns(null, [water(null, null, null)]);
  const failed = newRuns(first.next, [water("2026-10-02T14:15:00.000Z", "failed", "The model was not available.")]);
  assert.deepEqual(failed.fresh, [{
    key: "water@2026-10-02T14:15:00.000Z", title: "Drink water", body: "This didn't run: The model was not available.", failed: true
  }]);
  const interrupted = newRuns(first.next, [water("2026-10-02T14:15:00.000Z", "interrupted", "Started.")]);
  assert.deepEqual(interrupted.fresh, []);
});
