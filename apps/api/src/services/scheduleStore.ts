import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Scheduled work, and the arithmetic that decides when it is due.
//
// The whole point of this file is that a schedule on screen means something.
// A panel that says "Every day at 9:00 AM" while nothing runs at nine is the
// simulated signal this codebase refuses everywhere else, so the timing lives
// here as pure functions that can be tested against a fixed clock, and the
// thing that actually fires them lives in scheduler.ts.
//
// Local time throughout, deliberately. This is an app running on one person's
// machine; "nine in the morning" means nine where they are, and converting to
// UTC would make a daily schedule drift across a daylight-saving boundary.

export type Cadence =
  | { kind: "daily"; minuteOfDay: number }
  | { kind: "interval"; minutes: number };

export type ScheduleRunStatus = "ok" | "failed" | "missed";

/**
 * What a schedule does when it fires.
 *
 * "ask" puts a question to the assistant; "flow" runs the saved automation
 * flow. Kept as a tagged union rather than a nullable flow id because the two
 * are genuinely different actions, and a field that is sometimes a prompt and
 * sometimes not is how a store starts lying about its own contents.
 */
export type ScheduleAction =
  | { kind: "ask"; prompt: string }
  | { kind: "flow" };

export function isScheduleAction(value: unknown): value is ScheduleAction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; prompt?: unknown };
  if (candidate.kind === "flow") return true;
  return candidate.kind === "ask" && typeof candidate.prompt === "string" && candidate.prompt.trim().length > 0;
}

/** What the interface calls this action. */
export function describeAction(action: ScheduleAction): string {
  return action.kind === "flow" ? "Runs the saved flow" : `Asks: “${action.prompt}”`;
}

export type Schedule = {
  id: string;
  name: string;
  /**
   * What to ask when the action is "ask". Retained alongside `action` so a
   * schedule written before actions existed still loads — see loadFromDisk,
   * which fills the action in from it.
   */
  prompt: string;
  action: ScheduleAction;
  cadence: Cadence;
  enabled: boolean;
  createdAt: string;
  /** ISO time this is next expected to run. */
  nextDueAt: string;
  lastRunAt: string | null;
  lastStatus: ScheduleRunStatus | null;
  /** A short account of the last run — the reply's opening, or the failure. */
  lastDetail: string | null;
};

export const maxSchedules = 50;
export const maxPromptLength = 500;
export const maxDetailLength = 400;

/**
 * How late a daily schedule may fire and still be worth firing.
 *
 * Ten minutes. Past that it is not "the nine o'clock summary running a bit
 * late", it is yesterday's question answered against today's world — and the
 * machine having been asleep is the ordinary reason. Those are recorded as
 * missed rather than run, because silently producing a stale answer and
 * calling it the scheduled one would be worse than admitting it did not run.
 */
export const dailyGraceMs = 10 * 60 * 1000;

const minutesPerDay = 24 * 60;

export function isCadence(value: unknown): value is Cadence {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; minuteOfDay?: unknown; minutes?: unknown };
  if (candidate.kind === "daily") {
    return typeof candidate.minuteOfDay === "number"
      && Number.isInteger(candidate.minuteOfDay)
      && candidate.minuteOfDay >= 0
      && candidate.minuteOfDay < minutesPerDay;
  }
  if (candidate.kind === "interval") {
    // A floor of one minute: anything faster is a busy loop wearing a
    // schedule's clothing, and nothing here is worth running that often.
    return typeof candidate.minutes === "number"
      && Number.isInteger(candidate.minutes)
      && candidate.minutes >= 1
      && candidate.minutes <= minutesPerDay;
  }
  return false;
}

/** "Every day at 9:00 AM", "Every 30 minutes" — the words the interface shows. */
export function describeCadence(cadence: Cadence): string {
  if (cadence.kind === "interval") {
    if (cadence.minutes === 60) return "Every hour";
    if (cadence.minutes % 60 === 0) return `Every ${cadence.minutes / 60} hours`;
    return `Every ${cadence.minutes} minute${cadence.minutes === 1 ? "" : "s"}`;
  }

  const hours24 = Math.floor(cadence.minuteOfDay / 60);
  const minutes = cadence.minuteOfDay % 60;
  const suffix = hours24 < 12 ? "AM" : "PM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `Every day at ${hours12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

/**
 * The next time this cadence comes round, strictly after `from`.
 *
 * Strictly, so computing the next due time immediately after a run cannot
 * return the moment that just fired and loop.
 */
export function nextDueAfter(cadence: Cadence, from: Date): Date {
  if (cadence.kind === "interval") {
    return new Date(from.getTime() + cadence.minutes * 60_000);
  }

  const candidate = new Date(from);
  candidate.setHours(Math.floor(cadence.minuteOfDay / 60), cadence.minuteOfDay % 60, 0, 0);
  if (candidate.getTime() <= from.getTime()) {
    // setDate handles month and year rollover, and going through the Date API
    // rather than adding 86,400,000ms is what keeps this correct across a
    // daylight-saving change, where a local day is not 24 hours long.
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

export type DueVerdict = "run" | "missed" | "waiting";

/**
 * Whether a schedule should fire now, was missed, or is simply not due.
 *
 * Interval schedules are never "missed": one every thirty minutes that comes
 * back after an hour asleep should just run. A daily one is different — see
 * dailyGraceMs.
 */
export function dueVerdict(schedule: Schedule, now: Date): DueVerdict {
  if (!schedule.enabled) return "waiting";

  const due = new Date(schedule.nextDueAt).getTime();
  if (Number.isNaN(due) || now.getTime() < due) return "waiting";

  if (schedule.cadence.kind === "daily" && now.getTime() - due > dailyGraceMs) {
    return "missed";
  }
  return "run";
}

// ---- persistence -----------------------------------------------------------

type PersistedShape = { version: 1; schedules: Schedule[] };

const scheduleFilePath = process.env.ASSIST_SCHEDULE_FILE
  ?? path.join(process.cwd(), "data", "assist-schedules.json");

let schedules: Schedule[] = [];
let loaded = false;
let persistenceEnabled = process.env.ASSIST_SCHEDULE_PERSIST !== "off";
let lastPersistError: string | null = null;

export function schedulePersistenceError(): string | null {
  return lastPersistError;
}

function isSchedule(value: unknown): value is Schedule {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<Schedule>;
  return typeof entry.id === "string"
    && typeof entry.name === "string"
    && typeof entry.prompt === "string"
    && typeof entry.enabled === "boolean"
    && typeof entry.createdAt === "string"
    && typeof entry.nextDueAt === "string"
    && isCadence(entry.cadence);
}

/**
 * Fill in an action for a schedule stored before actions existed.
 *
 * Migrating on read rather than asking anyone to do anything: a schedule
 * written by an older build is a perfectly good "ask" schedule, and it should
 * simply keep working.
 */
function withAction(entry: Schedule): Schedule {
  if (isScheduleAction(entry.action)) return entry;
  return { ...entry, action: { kind: "ask", prompt: entry.prompt } };
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(scheduleFilePath)) return;

  try {
    const parsed = JSON.parse(readFileSync(scheduleFilePath, "utf8")) as Partial<PersistedShape>;
    if (Array.isArray(parsed.schedules)) {
      schedules = parsed.schedules.filter(isSchedule).map(withAction);
    }
  } catch {
    // A corrupt file must never take the API down; start clean instead.
  }
}

/** Same retry-and-report shape as the memory store, and for the same reason. */
const persistAttempts = 3;

function saveToDisk(): void {
  if (!persistenceEnabled) return;

  const payload: PersistedShape = { version: 1, schedules };
  const tempPath = `${scheduleFilePath}.tmp`;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= persistAttempts; attempt += 1) {
    try {
      mkdirSync(path.dirname(scheduleFilePath), { recursive: true });
      writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
      renameSync(tempPath, scheduleFilePath);
      lastPersistError = null;
      return;
    } catch (error) {
      lastError = error;
      const until = Date.now() + attempt * 5;
      while (Date.now() < until) { /* brief backoff for a transient lock */ }
    }
  }

  lastPersistError = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`schedules could not be saved after ${persistAttempts} attempts: ${lastPersistError}`);
  try { rmSync(tempPath, { force: true }); } catch { /* nothing more to do */ }
}

export function listSchedules(): Schedule[] {
  loadFromDisk();
  return schedules.map((entry) => ({ ...entry }));
}

export function addSchedule(
  input: { id: string; name: string; prompt?: string; action?: ScheduleAction; cadence: Cadence; now?: Date }
): Schedule | null {
  loadFromDisk();

  const name = input.name.trim();
  // The action is what actually matters; `prompt` is the older way of saying
  // the same thing for an "ask". Either is accepted so a caller never has to
  // supply both.
  const action: ScheduleAction | null = isScheduleAction(input.action)
    ? input.action
    : typeof input.prompt === "string" && input.prompt.trim()
      ? { kind: "ask", prompt: input.prompt.trim() }
      : null;

  if (!name || !action || !isCadence(input.cadence)) return null;
  if (schedules.length >= maxSchedules) return null;

  const prompt = action.kind === "ask" ? action.prompt.slice(0, maxPromptLength) : "";
  const now = input.now ?? new Date();
  const schedule: Schedule = {
    id: input.id,
    name: name.slice(0, 120),
    prompt,
    action: action.kind === "ask" ? { kind: "ask", prompt } : action,
    cadence: input.cadence,
    enabled: true,
    createdAt: now.toISOString(),
    nextDueAt: nextDueAfter(input.cadence, now).toISOString(),
    lastRunAt: null,
    lastStatus: null,
    lastDetail: null
  };

  schedules = [...schedules, schedule];
  saveToDisk();
  return { ...schedule };
}

export function setScheduleEnabled(id: string, enabled: boolean, now = new Date()): Schedule | null {
  loadFromDisk();
  const target = schedules.find((entry) => entry.id === id);
  if (!target) return null;

  target.enabled = enabled;
  // Re-enabling starts the clock again from now rather than firing instantly
  // for a due time that passed while it was off.
  if (enabled) target.nextDueAt = nextDueAfter(target.cadence, now).toISOString();
  saveToDisk();
  return { ...target };
}

export function removeSchedule(id: string): boolean {
  loadFromDisk();
  const next = schedules.filter((entry) => entry.id !== id);
  if (next.length === schedules.length) return false;
  schedules = next;
  saveToDisk();
  return true;
}

/** Record what a run did and move the schedule on to its next occurrence. */
export function recordRun(
  id: string,
  status: ScheduleRunStatus,
  detail: string,
  now = new Date()
): Schedule | null {
  loadFromDisk();
  const target = schedules.find((entry) => entry.id === id);
  if (!target) return null;

  // A missed run is not a run: it moves the schedule on and is noted, but
  // lastRunAt keeps pointing at the last time this actually did something.
  if (status !== "missed") {
    target.lastRunAt = now.toISOString();
  }
  target.lastStatus = status;
  target.lastDetail = detail.trim().slice(0, maxDetailLength) || null;
  target.nextDueAt = nextDueAfter(target.cadence, now).toISOString();
  saveToDisk();
  return { ...target };
}

export function resetSchedules(): void {
  schedules = [];
  loaded = true;
  saveToDisk();
}

export function setSchedulePersistence(enabled: boolean): void {
  persistenceEnabled = enabled;
}
