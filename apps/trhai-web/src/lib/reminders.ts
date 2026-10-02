// Scheduled runs, turned into reminders the user sees.
//
// The scheduler runs in the API whether or not anyone is looking, and records
// each run on its schedule - which nothing showed. "Remind me to drink water
// every day at 9:15" fired at 9:15 and told nobody. This finds the runs that
// happened since the app last looked; see useReminders for showing them.

/** The parts of a schedule, as /v1/schedules lists it, that say when it last ran. */
export type ScheduleRun = {
  id: string;
  name: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastDetail: string | null;
};

export type Reminder = { key: string; title: string; body: string; failed: boolean };

/**
 * Runs since the last look, and where each schedule now stands. The first look
 * (no `seen` yet) only records that: runs from before the app opened are
 * history, not news, and showing them all at once on every launch would bury
 * the one that matters.
 */
export function newRuns(seen: ReadonlyMap<string, string> | null, schedules: ScheduleRun[]): {
  fresh: Reminder[];
  next: Map<string, string>;
} {
  const next = new Map<string, string>();
  const fresh: Reminder[] = [];
  for (const schedule of schedules) {
    const at = schedule.lastRunAt ?? "";
    next.set(schedule.id, at);
    if (!seen || !at || seen.get(schedule.id) === at) continue;
    // "missed" and "interrupted" do not move lastRunAt, so anything here ran;
    // a run that failed is worth saying too, as what it is.
    const failed = schedule.lastStatus === "failed";
    if (!failed && schedule.lastStatus !== "ok") continue;
    fresh.push({
      key: `${schedule.id}@${at}`,
      title: schedule.name,
      body: failed ? `This didn't run: ${schedule.lastDetail ?? "the run failed."}` : (schedule.lastDetail ?? "Done."),
      failed
    });
  }
  return { fresh, next };
}
