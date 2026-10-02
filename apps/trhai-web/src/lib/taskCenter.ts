// How the Task center describes work: what a status is called, how long
// something took, when a schedule runs next, which schedule comes first and
// what a search keeps. Pure, so the wording and the ordering are testable
// without a screen.

export type TaskFilter = "all" | "running" | "scheduled" | "done" | "failed";

/** One of your own to-dos, as /v1/tasks keeps it. */
export type TaskItem = { id: string; title: string; done: boolean; createdAt: string };

/**
 * The session's current piece of work, as /v1/agent-tasks reports it. There
 * is no percentage on purpose: nothing in the agent knows how far through a
 * request it is, and a bar filling to 72% would be an animation, not a
 * measurement. What is real is the status, and whether it is running now.
 */
export type AgentTask = {
  id: string;
  status: "planned" | "executing" | "succeeded" | "failed" | "blocked";
  request: string;
  taskType: string;
  toolsUsed: string[];
  error?: string;
  lastResult?: string;
  createdAt?: string;
  updatedAt: string;
  /** Whether the API is working on it right now - measured, unlike `status`. */
  running?: boolean;
  /** Whether "continue" would pick it up. */
  resumable?: boolean;
};

export type FinishedStatus = "succeeded" | "failed" | "blocked" | "interrupted";

export type FinishedStep = {
  kind: string;
  label: string;
  status: "running" | "ok" | "failed" | "skipped";
  detail?: string;
  artifact?: string;
  startedAt: string;
  durationMs?: number;
};

export type FinishedTask = {
  id: string;
  request: string;
  taskType: string;
  status: FinishedStatus;
  toolsUsed: string[];
  result?: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
  steps: FinishedStep[];
};

export type ScheduleRun = {
  at: string;
  status: "ok" | "failed" | "missed" | "interrupted";
  detail: string | null;
  durationMs?: number;
};

/** The parts of the current task these functions read. */
type CurrentLike = { status: string; running?: boolean; resumable?: boolean };
/** The parts of a schedule these functions read. */
type ScheduleLike = { name?: string; enabled: boolean; running?: boolean; nextDueAt?: string; actionLabel?: string; cadenceLabel?: string };

export const filters: Array<{ id: TaskFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "scheduled", label: "Scheduled" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" }
];

/**
 * Where the current task really is. Running comes from the API's own count
 * of work in progress, never from the stored status: a task left "executing"
 * by a restart has stopped, whatever it says.
 */
export type TaskPhase = "running" | "stopped" | "done" | "failed" | "blocked";

export function taskPhase(task: CurrentLike): TaskPhase {
  if (task.running) return "running";
  if (task.status === "succeeded") return "done";
  if (task.status === "failed") return "failed";
  if (task.status === "blocked") return "blocked";
  return "stopped";
}

/**
 * Whether the current task is running, given the history as well.
 *
 * The history is read the moment the task moves, and a short task can finish
 * between that read and the next poll of the task itself - caught live, the
 * same task showing as running and as done for four seconds. One the history
 * already holds as finished, from this attempt rather than an earlier one
 * (a resumed task keeps its id), is not running, whatever the last poll said.
 */
export function isRunningNow(
  current: (CurrentLike & { id: string; updatedAt: string }) | null | undefined,
  history: FinishedTask[] | null | undefined
): boolean {
  if (!current?.running) return false;
  return !(history ?? []).some((task) => task.id === current.id && task.finishedAt >= current.updatedAt);
}

/** The current task, when it is waiting on "continue" from you. */
export function needsYou(task: CurrentLike | null | undefined): boolean {
  if (!task || task.running || !task.resumable) return false;
  return taskPhase(task) !== "done";
}

export const finishedWords: Record<FinishedStatus, string> = {
  succeeded: "Done", failed: "Failed", blocked: "Blocked", interrupted: "Interrupted"
};

export const runWords: Record<ScheduleRun["status"], string> = {
  ok: "Ran", failed: "Failed", missed: "Missed", interrupted: "Didn't finish"
};

const typeWords: Record<string, string> = {
  create: "Build", fix: "Fix", integrate: "Integration", migrate: "Migration", test: "Test",
  deploy: "Deploy", design: "Design", document: "Writing", analyze: "Analysis"
};

/** What kind of work it was - or null for the general kind, which needs no label. */
export function taskTypeLabel(type: string): string | null {
  return typeWords[type] ?? null;
}

/** A tool's name as a person would say it: "build_app" -> "build app". */
export function toolLabel(name: string): string {
  return name.replace(/_/g, " ");
}

/** The request on one line, short enough for a row. */
export function taskTitle(request: string, limit = 140): string {
  const line = request.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/** "320ms", "4.2s", "38s", "2m 05s", "1h 03m" - a measured length of time. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/**
 * How long something has been running, to the second. The clock behind it
 * ticks once a second, so tenths would only ever read ".0", and under a
 * second it has simply just started.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "just started";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return formatDuration(ms);
}

/** How long between two ISO times, or null when either cannot be read. */
export function between(from: string, to: string | Date): number | null {
  const start = Date.parse(from);
  const end = to instanceof Date ? to.getTime() : Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/** "due now", "in 12 min", "in 3 h 5 min", "in 2 days" - when a schedule next runs. */
export function dueLabel(iso: string | undefined, now: Date): string {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "";
  const ms = at - now.getTime();
  if (ms <= 30_000) return "due now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

const rankOf = (schedule: ScheduleLike) => (schedule.running ? 0 : schedule.enabled ? 1 : 2);
const dueOf = (schedule: ScheduleLike) => {
  const at = Date.parse(schedule.nextDueAt ?? "");
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
};

/** Running first, then whatever runs soonest, then the paused ones by name. */
export function orderSchedules<T extends ScheduleLike>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const rank = rankOf(a) - rankOf(b);
    if (rank !== 0) return rank;
    if (rankOf(a) === 1) {
      const due = dueOf(a) - dueOf(b);
      if (due !== 0 && Number.isFinite(due)) return due;
    }
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
}

function wordsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesAll(text: string, words: string[]): boolean {
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Finished work a search and a filter keep, in the order it came. */
export function filterHistory(list: FinishedTask[], query: string, filter: TaskFilter): FinishedTask[] {
  if (filter === "running" || filter === "scheduled") return [];
  const words = wordsOf(query);
  return list.filter((task) => {
    if (filter === "done" && task.status !== "succeeded") return false;
    if (filter === "failed" && task.status === "succeeded") return false;
    return matchesAll(`${task.request} ${task.result ?? ""} ${task.error ?? ""} ${task.toolsUsed.join(" ")}`, words);
  });
}

/** Schedules a search keeps, in the order they matter. */
export function filterSchedules<T extends ScheduleLike>(list: T[], query: string): T[] {
  const words = wordsOf(query);
  return orderSchedules(list).filter((schedule) =>
    matchesAll(`${schedule.name ?? ""} ${schedule.actionLabel ?? ""} ${schedule.cadenceLabel ?? ""}`, words));
}

/** The counts on the filter, each from the list it filters. */
export function countWork(current: CurrentLike | null | undefined, history: FinishedTask[], schedules: ScheduleLike[]): Record<Exclude<TaskFilter, "all">, number> {
  return {
    running: (current?.running ? 1 : 0) + schedules.filter((schedule) => schedule.running).length,
    scheduled: schedules.length,
    done: history.filter((task) => task.status === "succeeded").length,
    failed: history.filter((task) => task.status !== "succeeded").length
  };
}

/**
 * A schedule's timing from the form: a time of day, or every so many minutes
 * or hours. Null for anything the API would refuse - an interval under a
 * minute or over a day, or a time that is not a time.
 */
export type CadenceDraft =
  | { kind: "daily"; time: string; weekdaysOnly: boolean }
  | { kind: "interval"; every: number; unit: "minutes" | "hours" };

export function cadenceFrom(draft: CadenceDraft):
  { kind: "daily"; minuteOfDay: number; weekdaysOnly?: boolean } | { kind: "interval"; minutes: number } | null {
  if (draft.kind === "daily") {
    const match = /^(\d{1,2}):(\d{2})$/.exec(draft.time.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return { kind: "daily", minuteOfDay: hours * 60 + minutes, ...(draft.weekdaysOnly ? { weekdaysOnly: true } : {}) };
  }
  if (!Number.isInteger(draft.every) || draft.every < 1) return null;
  const minutes = draft.unit === "hours" ? draft.every * 60 : draft.every;
  return minutes <= 24 * 60 ? { kind: "interval", minutes } : null;
}
