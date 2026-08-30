import test from "node:test";
import assert from "node:assert/strict";
import {
  addSchedule,
  claimRun,
  dailyGraceMs,
  describeAction,
  describeCadence,
  dueVerdict,
  isCadence,
  isScheduleAction,
  listSchedules,
  nextDueAfter,
  recordRun,
  removeSchedule,
  resetSchedules,
  setScheduleEnabled,
  setSchedulePersistence,
  type Schedule
} from "../src/services/scheduleStore.js";

setSchedulePersistence(false);

// The timing is the whole feature. A panel saying "Every day at 9:00 AM" is
// only honest if something actually comes due at nine, so every one of these
// runs against a fixed clock rather than the wall clock.

/** 14 March 2026, 08:00 local. */
const morning = () => new Date(2026, 2, 14, 8, 0, 0, 0);

function seed(cadence: Schedule["cadence"], now = morning()): Schedule {
  resetSchedules();
  const created = addSchedule({ id: "s1", name: "Daily summary", prompt: "Summarise today", cadence, now });
  assert.ok(created, "expected the schedule to be created");
  return created;
}

test("a cadence is described the way the interface shows it", () => {
  assert.equal(describeCadence({ kind: "daily", minuteOfDay: 9 * 60 }), "Every day at 9:00 AM");
  assert.equal(describeCadence({ kind: "daily", minuteOfDay: 15 * 60 + 30 }), "Every day at 3:30 PM");
  // Midnight and noon are the two the 12-hour clock gets wrong most often.
  assert.equal(describeCadence({ kind: "daily", minuteOfDay: 0 }), "Every day at 12:00 AM");
  assert.equal(describeCadence({ kind: "daily", minuteOfDay: 12 * 60 }), "Every day at 12:00 PM");
  assert.equal(describeCadence({ kind: "interval", minutes: 60 }), "Every hour");
  assert.equal(describeCadence({ kind: "interval", minutes: 180 }), "Every 3 hours");
  assert.equal(describeCadence({ kind: "interval", minutes: 30 }), "Every 30 minutes");
  assert.equal(describeCadence({ kind: "interval", minutes: 1 }), "Every 1 minute");
});

test("nonsense cadences are refused rather than stored", () => {
  assert.equal(isCadence({ kind: "daily", minuteOfDay: 1440 }), false, "past the end of a day");
  assert.equal(isCadence({ kind: "daily", minuteOfDay: -1 }), false);
  assert.equal(isCadence({ kind: "daily", minuteOfDay: 9.5 }), false, "must be a whole minute");
  assert.equal(isCadence({ kind: "interval", minutes: 0 }), false, "a busy loop, not a schedule");
  assert.equal(isCadence({ kind: "interval", minutes: 2000 }), false, "longer than a day");
  assert.equal(isCadence({ kind: "weekly" }), false);
  assert.equal(isCadence(null), false);
});

test("the next daily occurrence is today when it is still ahead", () => {
  const at9 = nextDueAfter({ kind: "daily", minuteOfDay: 9 * 60 }, morning());
  assert.equal(at9.getDate(), 14);
  assert.equal(at9.getHours(), 9);
  assert.equal(at9.getMinutes(), 0);
});

test("the next daily occurrence rolls to tomorrow once today's has passed", () => {
  // 08:00 now, 07:00 target — today's is gone.
  const at7 = nextDueAfter({ kind: "daily", minuteOfDay: 7 * 60 }, morning());
  assert.equal(at7.getDate(), 15);
  assert.equal(at7.getHours(), 7);
});

test("a daily time exactly now still moves to tomorrow, so a run cannot loop", () => {
  // Strictly after: returning the moment that just fired would make the
  // scheduler run the same job forever.
  const now = morning();
  const next = nextDueAfter({ kind: "daily", minuteOfDay: 8 * 60 }, now);
  assert.ok(next.getTime() > now.getTime());
  assert.equal(next.getDate(), 15);
});

test("a daily schedule crossing a month end lands on the first, not the thirty-second", () => {
  const lastDay = new Date(2026, 2, 31, 23, 0, 0, 0);
  const next = nextDueAfter({ kind: "daily", minuteOfDay: 9 * 60 }, lastDay);
  assert.equal(next.getMonth(), 3, "April");
  assert.equal(next.getDate(), 1);
});

test("an interval is measured from the moment given", () => {
  const next = nextDueAfter({ kind: "interval", minutes: 45 }, morning());
  assert.equal(next.getTime() - morning().getTime(), 45 * 60_000);
});

test("a schedule is not due before its time", () => {
  const schedule = seed({ kind: "daily", minuteOfDay: 9 * 60 });
  assert.equal(dueVerdict(schedule, new Date(2026, 2, 14, 8, 59, 0)), "waiting");
});

test("a schedule is due at its time", () => {
  const schedule = seed({ kind: "daily", minuteOfDay: 9 * 60 });
  assert.equal(dueVerdict(schedule, new Date(2026, 2, 14, 9, 0, 0)), "run");
});

test("a daily schedule slightly late still runs", () => {
  const schedule = seed({ kind: "daily", minuteOfDay: 9 * 60 });
  const slightlyLate = new Date(new Date(2026, 2, 14, 9, 0, 0).getTime() + dailyGraceMs - 1000);
  assert.equal(dueVerdict(schedule, slightlyLate), "run");
});

test("a daily schedule long past its time is missed, not run late", () => {
  // The machine was off. Answering this morning's question at six in the
  // evening and calling it the nine o'clock run would be worse than saying
  // plainly that it did not happen.
  const schedule = seed({ kind: "daily", minuteOfDay: 9 * 60 });
  assert.equal(dueVerdict(schedule, new Date(2026, 2, 14, 18, 0, 0)), "missed");
});

test("an interval schedule is never missed, only late", () => {
  // Every thirty minutes, coming back after an hour asleep, should just run.
  const schedule = seed({ kind: "interval", minutes: 30 });
  assert.equal(dueVerdict(schedule, new Date(2026, 2, 14, 10, 0, 0)), "run");
});

test("a disabled schedule is never due", () => {
  seed({ kind: "daily", minuteOfDay: 9 * 60 });
  const off = setScheduleEnabled("s1", false);
  assert.ok(off);
  assert.equal(dueVerdict(off, new Date(2026, 2, 14, 9, 0, 0)), "waiting");
});

test("re-enabling starts the clock again rather than firing instantly", () => {
  seed({ kind: "interval", minutes: 60 });
  setScheduleEnabled("s1", false);

  const laterOn = new Date(2026, 2, 14, 12, 0, 0);
  const back = setScheduleEnabled("s1", true, laterOn);
  assert.ok(back);
  // Due an hour after being switched on, not the moment it comes back.
  assert.equal(dueVerdict(back, laterOn), "waiting");
  assert.equal(new Date(back.nextDueAt).getTime(), laterOn.getTime() + 60 * 60_000);
});

test("a completed run is recorded and the schedule moves on", () => {
  seed({ kind: "daily", minuteOfDay: 9 * 60 });
  const ranAt = new Date(2026, 2, 14, 9, 0, 5);
  const after = recordRun("s1", "ok", "Here is what changed today.", ranAt);

  assert.ok(after);
  assert.equal(after.lastStatus, "ok");
  assert.equal(after.lastRunAt, ranAt.toISOString());
  assert.match(after.lastDetail ?? "", /changed today/);
  // Moved to tomorrow, so it cannot fire twice in one day.
  assert.equal(new Date(after.nextDueAt).getDate(), 15);
});

test("a missed run moves the schedule on without claiming it ran", () => {
  seed({ kind: "daily", minuteOfDay: 9 * 60 });
  const after = recordRun("s1", "missed", "The machine was not running.", new Date(2026, 2, 14, 18, 0, 0));

  assert.ok(after);
  assert.equal(after.lastStatus, "missed");
  // The important part: lastRunAt still points at the last real run, which
  // here is none at all. A missed run is not a run.
  assert.equal(after.lastRunAt, null);
  assert.equal(new Date(after.nextDueAt).getDate(), 15);
});

test("a failed run is recorded as failed rather than passed over", () => {
  seed({ kind: "interval", minutes: 30 });
  const after = recordRun("s1", "failed", "The local model could not be reached.", morning());

  assert.ok(after);
  assert.equal(after.lastStatus, "failed");
  assert.match(after.lastDetail ?? "", /could not be reached/);
});

test("a schedule needs a name and a prompt", () => {
  resetSchedules();
  const cadence = { kind: "daily" as const, minuteOfDay: 540 };
  assert.equal(addSchedule({ id: "a", name: "  ", prompt: "x", cadence }), null);
  assert.equal(addSchedule({ id: "b", name: "x", prompt: "   ", cadence }), null);
  assert.deepEqual(listSchedules(), []);
});

test("schedules are created enabled, with a first due time already set", () => {
  const schedule = seed({ kind: "daily", minuteOfDay: 9 * 60 });
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.lastRunAt, null);
  assert.ok(new Date(schedule.nextDueAt).getTime() > morning().getTime());
});

test("removing a schedule takes it out; removing it again reports nothing changed", () => {
  seed({ kind: "daily", minuteOfDay: 9 * 60 });
  assert.equal(removeSchedule("s1"), true);
  assert.deepEqual(listSchedules(), []);
  assert.equal(removeSchedule("s1"), false);
});

test("a bare prompt still creates an ask schedule, so nothing has to be chosen", () => {
  resetSchedules();
  const created = addSchedule({
    id: "s1", name: "Brief", prompt: "Summarise today",
    cadence: { kind: "daily", minuteOfDay: 540 }
  });

  assert.ok(created);
  assert.deepEqual(created.action, { kind: "ask", prompt: "Summarise today" });
});

test("a flow schedule needs no prompt at all", () => {
  resetSchedules();
  const created = addSchedule({
    id: "s2", name: "Nightly flow", action: { kind: "flow" },
    cadence: { kind: "daily", minuteOfDay: 180 }
  });

  assert.ok(created, "a flow is the instruction; there is nothing to ask");
  assert.deepEqual(created.action, { kind: "flow" });
  assert.equal(created.prompt, "");
});

test("a schedule with neither a prompt nor an action is refused", () => {
  resetSchedules();
  assert.equal(
    addSchedule({ id: "s3", name: "Nothing", cadence: { kind: "daily", minuteOfDay: 540 } }),
    null
  );
});

test("an action is described the way the interface shows it", () => {
  assert.equal(describeAction({ kind: "flow" }), "Runs the saved flow");
  assert.match(describeAction({ kind: "ask", prompt: "Summarise today" }), /Summarise today/);
});

test("a malformed action is refused rather than half-accepted", () => {
  assert.equal(isScheduleAction({ kind: "ask" }), false, "ask with no prompt");
  assert.equal(isScheduleAction({ kind: "ask", prompt: "   " }), false, "ask with a blank prompt");
  assert.equal(isScheduleAction({ kind: "elsewhere" }), false);
  assert.equal(isScheduleAction(null), false);
  assert.equal(isScheduleAction({ kind: "flow" }), true);
});

test("listing returns copies, so a caller cannot mutate the store by accident", () => {
  seed({ kind: "daily", minuteOfDay: 9 * 60 });
  const [copy] = listSchedules();
  copy.enabled = false;
  assert.equal(listSchedules()[0].enabled, true);
});

// --- idempotency (E6-S3) ---------------------------------------------------

test("a claimed run is not still due, so a restart cannot repeat it", () => {
  const schedule = seed({ kind: "daily", minuteOfDay: 9 * 60 });

  const due = new Date(schedule.nextDueAt);
  const firing = new Date(due.getTime() + 1000);

  // Due when the tick finds it.
  assert.equal(dueVerdict(schedule, firing), "run");

  // The run is claimed, then the process dies before recordRun — which is
  // exactly the window that used to duplicate side effects, because a local
  // model turn can take half a minute and nextDueAt only moved afterwards.
  const claimed = claimRun(schedule.id, firing);
  assert.ok(claimed);

  const afterRestart = listSchedules().find((entry) => entry.id === schedule.id);
  assert.ok(afterRestart);
  assert.notEqual(
    afterRestart.nextDueAt, schedule.nextDueAt,
    "claiming a run left the due time where it was"
  );
  assert.equal(
    dueVerdict(afterRestart, firing), "waiting",
    "a claimed run was still due, so the tick at startup would run it a second time"
  );
});

test("an interrupted run says so rather than showing a status it did not earn", () => {
  const schedule = seed({ kind: "daily", minuteOfDay: 9 * 60 });

  claimRun(schedule.id, new Date(schedule.nextDueAt));
  const claimed = listSchedules().find((entry) => entry.id === schedule.id);
  assert.ok(claimed);

  assert.equal(claimed.lastStatus, "interrupted");
  // And it is not counted as a completed run: lastRunAt still points at the
  // last time this genuinely did something, which is never.
  assert.equal(claimed.lastRunAt, null);
});

test("a run that finishes overwrites its own claim", () => {
  const schedule = seed({ kind: "daily", minuteOfDay: 9 * 60 });

  claimRun(schedule.id, new Date(schedule.nextDueAt));
  recordRun(schedule.id, "ok", "Ran fine.");

  const done = listSchedules().find((entry) => entry.id === schedule.id);
  assert.ok(done);
  assert.equal(done.lastStatus, "ok");
  assert.ok(done.lastRunAt, "a completed run did not record when it happened");
});

test("claiming a schedule that no longer exists is refused", () => {
  resetSchedules();
  // The caller must be able to tell a granted claim from a missing schedule,
  // or it would go on to do the work for something that was deleted.
  assert.equal(claimRun("no-such-schedule"), null);
});
