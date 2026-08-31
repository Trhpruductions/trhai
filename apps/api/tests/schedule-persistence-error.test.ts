import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A store that can no longer save has to say so.
//
// scheduleStore has recorded the last write failure since it was written, and
// nothing ever read it. So a locked file or a full disk produced a scheduler
// that kept accepting schedules, logged once to a console nobody has open, and
// reported itself running - right up to the restart that lost all of them.
//
// This lives in its own file because schedule-store.test.ts turns persistence
// off for every test in it, and the whole point here is to let a real write be
// attempted and fail.

// Set before the import: scheduleStore reads its path once, at module load.
const directory = mkdtempSync(path.join(tmpdir(), "trhai-sched-"));
const blocker = path.join(directory, "blocker");
// A *file* where the store needs a directory, so creating the parent fails.
writeFileSync(blocker, "not a directory", "utf8");
process.env.ASSIST_SCHEDULE_FILE = path.join(blocker, "schedules.json");
process.env.ASSIST_SCHEDULE_PERSIST = "on";

const store = await import("../src/services/scheduleStore.js");

test("a schedule that could not be written is reported, not swallowed", () => {
  store.resetSchedules();

  const created = store.addSchedule({
    id: "s1",
    name: "Daily summary",
    prompt: "Summarise today",
    cadence: { kind: "daily", minuteOfDay: 9 * 60 },
    now: new Date(2026, 2, 14, 8, 0, 0, 0)
  });

  assert.ok(created, "the schedule is still accepted in memory");

  const reported = store.schedulePersistenceError();
  assert.ok(
    reported !== null,
    "the store failed to write and reported nothing - the silence this test exists for"
  );
});

test("the schedule is still usable in memory after a failed write", () => {
  // Failing to save must not also mean failing to work for the current run.
  // The schedule is real until the process ends; what is lost is the restart.
  assert.equal(store.listSchedules().length, 1);
});
