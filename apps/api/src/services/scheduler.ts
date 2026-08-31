import { executeFlow } from "@ascend/shared";
import { runAssistantOrchestrator } from "./orchestrator.js";
import { getFlow } from "./flowStore.js";
import { claimRun, dueVerdict, listSchedules, recordRun, type ScheduleAction } from "./scheduleStore.js";

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

/**
 * Run the saved automation flow.
 *
 * No script runner is passed, exactly as in a browser tab: RUN SCRIPT goes
 * through the desktop shell's fixed list of named checks, and giving the API
 * process the ability to run commands on a timer would be a far larger
 * decision than "schedules can trigger flows". executeFlow already reports
 * that step as skipped with its reason, so a scheduled flow says what it did
 * and did not do rather than quietly appearing to have run everything.
 */
// No id parameter: there is one saved flow, not a flow per schedule, and
// getFlow() is how it is reached. The argument was passed and ignored.
async function runFlowAction(): Promise<{ status: "ok" | "failed"; detail: string }> {
  const flow = getFlow();
  if (!flow) {
    return { status: "failed", detail: "No flow is saved, so there was nothing to run." };
  }

  const run = await executeFlow(flow, { dryRun: false });
  const counts = run.steps.reduce<Record<string, number>>((tally, step) => {
    tally[step.status] = (tally[step.status] ?? 0) + 1;
    return tally;
  }, {});

  const summary = Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(", ");
  const detail = `${flow.name}: ${summary || "nothing to do"}`;

  // A flow whose own steps failed is a failed run. Reporting it as ok
  // because the runner itself did not throw would be the quiet kind of wrong.
  return { status: run.failed ? "failed" : "ok", detail };
}

async function runSchedule(id: string, name: string, action: ScheduleAction): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);

  // Claimed before the work, not after.
  //
  // inFlight only guards a second fire inside this process. A restart during
  // a run loses it, and the schedule — whose nextDueAt had not moved — was
  // still due, so the tick at startup ran it again. Advancing the due time
  // now means an interrupted run is lost rather than repeated.
  if (!claimRun(id)) {
    inFlight.delete(id);
    return;
  }

  try {
    if (action.kind === "flow") {
      const { status, detail } = await runFlowAction();
      recordRun(id, status, detail);
      console.log(`schedule "${name}" ${status === "ok" ? "ran the flow" : "failed"}: ${detail}`);
      return;
    }

    const result = await runAssistantOrchestrator({
      // Nobody is watching a timer fire, so this turn never gets command
      // access even if machine control happens to be switched on.
      unattended: true,
      mode: "general",
      userMessage: action.prompt,
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
      void runSchedule(schedule.id, schedule.name, schedule.action);
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
