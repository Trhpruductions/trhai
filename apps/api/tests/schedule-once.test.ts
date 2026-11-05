import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "trhai-once-"));
process.env.ASSIST_SCHEDULE_PERSIST = "off";
const {
  addSchedule, calendarWords, claimRun, describeCadence, dueVerdict, isCadence, listScheduleRuns, listSchedules, nextDueAfter,
  onceGraceMs, recordRun, resetSchedules, setScheduleEnabled, setSchedulePersistence
} = await import("../src/services/scheduleStore.js");
const { runTool } = await import("../src/services/agentTools.js");
const { tick } = await import("../src/services/scheduler.js");
const { parseOnceTime } = await import("../src/services/onceTime.js");

setSchedulePersistence(false);

// A schedule that runs once, at a date and time: "remind me at three to call the bank".
// Against a fixed clock, like the rest of the scheduler's tests.

/** Wednesday 4 November 2026, 10:00 local. */
const morning = () => new Date(2026, 10, 4, 10, 0, 0, 0);
const threePm = () => new Date(2026, 10, 4, 15, 0, 0, 0);
const once = () => ({ kind: "once" as const, at: threePm().toISOString() });
const later = (from: Date, ms: number) => new Date(from.getTime() + ms);

test("a one-time cadence is a real instant, described by its day and time, due at that moment and no other", () => {
  assert.equal(isCadence(once()), true);
  assert.equal(isCadence({ kind: "once", at: "sometime" }), false);
  assert.equal(calendarWords(threePm()), "Wed 4 Nov 2026 at 3:00 PM");
  assert.equal(describeCadence(once()), "Once, on Wed 4 Nov 2026 at 3:00 PM");
  assert.equal(nextDueAfter(once(), morning()).getTime(), threePm().getTime());
  assert.equal(nextDueAfter(once(), later(threePm(), 60_000)).getTime(), threePm().getTime(), "its moment is its moment");
});

test("it fires once, within two hours of its time, and is then over: off, still on the list, never fired again", () => {
  resetSchedules();
  const saved = addSchedule({ id: "once-1", name: "Bank", action: { kind: "remind", text: "Call the bank" }, cadence: once(), now: morning() });
  assert.ok(saved);
  assert.equal(dueVerdict(saved, morning()), "waiting");
  assert.equal(dueVerdict(saved, later(threePm(), 60_000)), "run");
  assert.equal(dueVerdict(saved, later(threePm(), onceGraceMs + 60_000)), "missed");

  const claimed = claimRun("once-1", later(threePm(), 60_000));
  assert.equal(claimed?.enabled, false, "claimed, it is over");
  recordRun("once-1", "ok", "Call the bank", later(threePm(), 61_000));
  const after = listSchedules()[0];
  assert.equal(after.enabled, false);
  assert.equal(after.lastStatus, "ok");
  assert.equal(dueVerdict(after, later(threePm(), 120_000)), "waiting", "off, so never due again");
  // Turning it back on would be asking for a moment that has passed.
  assert.equal(setScheduleEnabled("once-1", true, later(threePm(), 120_000))?.enabled, false);
});

test("a moment that has passed is refused, and a missed one-time schedule is over too", () => {
  resetSchedules();
  assert.equal(addSchedule({ id: "late", name: "Late", action: { kind: "remind", text: "x" }, cadence: once(), now: later(threePm(), 1) }), null);
  const saved = addSchedule({ id: "m", name: "Missed", action: { kind: "remind", text: "x" }, cadence: once(), now: morning() });
  assert.ok(saved);
  recordRun("m", "missed", "The machine was not running when this was due.", later(threePm(), onceGraceMs + 60_000));
  const after = listSchedules()[0];
  assert.equal(after.enabled, false);
  assert.equal(after.lastStatus, "missed");
});

test("the scheduler fires a one-time reminder once and not again", async () => {
  resetSchedules();
  addSchedule({ id: "t", name: "Bank", action: { kind: "remind", text: "Call the bank" }, cadence: once(), now: morning() });
  await tick(morning());
  assert.equal(listScheduleRuns("t")?.length, 0, "not yet");
  await tick(later(threePm(), 30_000));
  await new Promise((resolve) => setImmediate(resolve));
  const runs = listScheduleRuns("t") ?? [];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "ok");
  assert.equal(runs[0].detail, "Call the bank");
  assert.equal(listSchedules()[0].enabled, false);
  await tick(later(threePm(), 90_000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((listScheduleRuns("t") ?? []).length, 1, "no second firing");
});

test("the moment is read as a plain local date and time, or an ISO instant, and nothing looser", () => {
  const now = morning();
  assert.equal(parseOnceTime("2026-11-04 15:00", now).ok, true);
  assert.equal(parseOnceTime("2026-11-04T15:00", now).ok, true);
  assert.equal(parseOnceTime("2026-11-05T15:00:00Z", now).ok, true);
  assert.equal(parseOnceTime("2026-02-30 10:00", now).ok, false, "not a real date");
  assert.equal(parseOnceTime("tomorrow at 3", now).ok, false);
  assert.equal(parseOnceTime("2027-11-06 10:00", now).ok, false, "more than a year away");
  assert.equal(parseOnceTime("2026-11-04 09:00", now).ok, false, "passed");
});

test("the tool schedules a reminder once at a date and time, with the time of day from the user's own words", async () => {
  resetSchedules();
  const context = { memories: [], knowledge: [], now: () => morning(), request: "remind me at 3pm to call the bank" };
  const result = await runTool({ name: "add_schedule", arguments: { name: "Call the bank", reminder: "Call the bank", at: "2026-11-04 14:00" } }, context);
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /Scheduled "Call the bank": Once, on Wed 4 Nov 2026 at 3:00 PM/);
  const saved = listSchedules()[0];
  assert.equal(saved.action.kind, "remind");
  assert.equal(saved.cadence.kind, "once");
  assert.equal(saved.enabled, true);

  // The same one asked for again is reported as done, not made twice.
  const again = await runTool({ name: "add_schedule", arguments: { name: "Call the bank", reminder: "Call the bank", at: "2026-11-04 15:00" } }, context);
  assert.equal(again.ok, true);
  assert.match(again.content, /Already scheduled/);

  // Past, unreadable, two kinds at once, or nothing to say: refused with the reason, nothing saved.
  const refusals: Array<[Record<string, unknown>, RegExp]> = [
    [{ name: "x", reminder: "x", at: "2026-11-04 09:00" }, /already passed/],
    [{ name: "x", reminder: "x", at: "next Tuesday" }, /not a date and time/],
    [{ name: "x", reminder: "x", at: "2026-11-05 09:00", daily_at: "09:00" }, /one or the other/],
    [{ name: "x", at: "2026-11-05 09:00" }, /what to ask/]
  ];
  for (const [args, reason] of refusals) {
    const refused = await runTool({ name: "add_schedule", arguments: args }, { ...context, request: undefined });
    assert.equal(refused.ok, false, JSON.stringify(args));
    assert.match(refused.content, reason, JSON.stringify(args));
  }
  assert.equal(listSchedules().length, 1);

  const listed = await runTool({ name: "list_schedules", arguments: {} }, context);
  assert.match(listed.content, /Call the bank: Once, on Wed 4 Nov 2026 at 3:00 PM - Reminds you/);
});
