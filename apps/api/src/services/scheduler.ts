import { runAssistantOrchestrator } from "./orchestrator.js";
import { dueVerdict, listSchedules, recordRun } from "./scheduleStore.js";

// The thing that makes a schedule real.
//
// Everything else about this feature is storage and arithmetic; this is the
// part that means a panel reading "Every day at 9:00 AM" is a statement about
// what the machine does rather than a picture of one. It runs inside the API
// process, which is the only honest place for it: a browser timer fires only
// while a tab happens to be open, so a daily schedule driven from the page
// would simply not happen on the mornings nobody opened the app.
//
// Started from index.ts, never from createApp(), so the test suite — which
// builds an app on almost every file — never sets a live scheduler running
// and fires real assistant requests at a local model.

/**
 * How often to look for due work.
 *
 * Thirty seconds. The finest cadence offered is one minute, so this cannot
 * make a schedule late by more than half its smallest unit, and it is cheap
 * enough to run forever on an idle machine.
 */
const tickMs = 30_000;

/** Kept out of the reply's own length: this is a note, not a transcript. */
const detailLength = 200;

let timer: NodeJS.Timeout | null = null;
/** Ids currently executing, so a slow run is never started twice. */
const inFlight = new Set<string>();

async function runSchedule(id: string, name: string, prompt: string): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);

  try {
    const result = await runAssistantOrchestrator({
      mode: "general",
      userMessage: prompt,
      // A schedule gets its own conversation, kept apart from whatever the
      // user is doing: a summary firing at nine should not appear in the
      // middle of a conversation they are having, or take context from it.
      sessionId: `schedule:${id}`
    });

    const reply = (result.assistantMessage ?? "").trim();
    recordRun(id, "ok", reply.slice(0, detailLength) || "Ran, with no reply text.");
    console.log(`schedule "${name}" ran`);
  } catch (error) {
    // A failed run is recorded as failed. The alternative — a schedule that
    // quietly stops working while still showing a next-run time — is the
    // exact dishonesty this whole feature was built to avoid.
    const detail = error instanceof Error ? error.message : "The scheduled run failed.";
    recordRun(id, "failed", detail);
    console.error(`schedule "${name}" failed: ${detail}`);
  } finally {
    inFlight.delete(id);
  }
}

/** One pass over every schedule. Exported so a test can drive it directly. */
export async function tick(now = new Date()): Promise<void> {
  for (const schedule of listSchedules()) {
    const verdict = dueVerdict(schedule, now);

    if (verdict === "missed") {
      // Rolled forward and noted rather than run late — see dailyGraceMs.
      recordRun(schedule.id, "missed", "The machine was not running when this was due.", now);
      continue;
    }

    if (verdict === "run") {
      // Deliberately not awaited: one slow schedule must not hold up the
      // others, and each guards itself against overlapping with a second
      // copy of itself.
      void runSchedule(schedule.id, schedule.name, schedule.prompt);
    }
  }
}

export function startScheduler(): void {
  if (timer) return;
  // An immediate pass on startup, so anything missed while the machine was
  // off is resolved now rather than sitting due-looking for half a minute.
  void tick();
  timer = setInterval(() => { void tick(); }, tickMs);
  // Never hold the process open on the scheduler's account.
  timer.unref?.();
  console.log(`scheduler running, checking every ${tickMs / 1000}s`);
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
