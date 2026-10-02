import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./dataDirectory.js";
import { listEvents, type ExecutionEvent } from "./executionLog.js";
import { assertProtectedJsonWritable, readProtectedJsonFile, writeProtectedJsonFile } from "./protectedJson.js";
import { recordPersistFailure, recordPersistSuccess } from "./persistenceHealth.js";
import { getTask, isTaskRunning, markTaskRunning, updateTask, type StoredTask } from "./taskStore.js";

// The work TRH AI has finished, and how each piece went.
//
// taskStore keeps one task per session - the one "continue" would resume - and
// every new request replaces it. So the moment a second piece of work began,
// the first was gone: whether it succeeded, what it ran, why it failed. This
// is that record, kept: each task as it ended, with the steps the execution
// log saw while it ran, which are otherwise cleared when the next request
// starts.
//
// Written when a task ends, by the code that ended it, and never
// reconstructed afterwards. A task resumed after it failed is the same task,
// so it is updated in place rather than listed twice, and its steps carry
// across attempts the way taskStore's tools already do.

/** How a task ended. "interrupted" is a task that never reported an end at all. */
export type FinishedStatus = "succeeded" | "failed" | "blocked" | "interrupted";

export type FinishedStep = {
  kind: string;
  label: string;
  /** "running" survives only when the task ended with this step still open. */
  status: ExecutionEvent["status"];
  detail?: string;
  artifact?: string;
  startedAt: string;
  durationMs?: number;
};

export type FinishedTask = {
  /** taskStore's id, so a resumed task lands on its own entry. */
  id: string;
  request: string;
  taskType: string;
  status: FinishedStatus;
  toolsUsed: string[];
  /** What the assistant reported, when it succeeded. */
  result?: string;
  /** Why it stopped, when it did not. */
  error?: string;
  startedAt: string;
  finishedAt: string;
  steps: FinishedStep[];
};

/**
 * Caps, so an unauthenticated caller cannot grow the file without bound and
 * the write each finished task makes stays small. Every task here cost a
 * model turn to produce, so the realistic size is far below them.
 */
export const maxFinishedPerSession = 40;
export const maxTrackedHistorySessions = 50;
export const maxStepsPerTask = 30;
const maxTextLength = 1500;
const maxStepDetailLength = 300;

const historyFilePath = process.env.ASSIST_TASK_HISTORY_FILE
  ?? dataFile("task-history.json");

const persistenceEnabled = process.env.ASSIST_TASK_HISTORY_PERSIST !== "off";
let loaded = false;

/** Newest first. Map order is recency of use, so the first key is evicted first. */
const historyByKey = new Map<string, FinishedTask[]>();

const finishedStatuses: FinishedStatus[] = ["succeeded", "failed", "blocked", "interrupted"];
const stepStatuses: Array<ExecutionEvent["status"]> = ["running", "ok", "failed", "skipped"];

function clamp(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function isStep(value: unknown): value is FinishedStep {
  if (!value || typeof value !== "object") return false;
  const step = value as Partial<FinishedStep>;
  return typeof step.kind === "string"
    && typeof step.label === "string"
    && stepStatuses.includes(step.status as ExecutionEvent["status"])
    && typeof step.startedAt === "string";
}

function isFinishedTask(value: unknown): value is FinishedTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<FinishedTask>;
  return typeof task.id === "string"
    && typeof task.request === "string"
    && typeof task.taskType === "string"
    && finishedStatuses.includes(task.status as FinishedStatus)
    && Array.isArray(task.toolsUsed)
    && task.toolsUsed.every((tool) => typeof tool === "string")
    && typeof task.startedAt === "string"
    && typeof task.finishedAt === "string"
    && Array.isArray(task.steps)
    && task.steps.every(isStep);
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(historyFilePath)) return;

  try {
    const parsed = readProtectedJsonFile(historyFilePath) as { sessions?: Array<{ key?: unknown; tasks?: unknown }> };
    for (const entry of parsed.sessions ?? []) {
      if (!entry || typeof entry.key !== "string" || !Array.isArray(entry.tasks)) continue;
      const tasks = entry.tasks.filter(isFinishedTask).slice(0, maxFinishedPerSession);
      if (tasks.length > 0) historyByKey.set(entry.key, tasks);
    }
  } catch {
    // A corrupt file must not take the API down; the history starts empty.
  }
}

function saveToDisk(): void {
  if (!persistenceEnabled) return;
  try {
    const payload = {
      version: 1,
      sessions: [...historyByKey.entries()].map(([key, tasks]) => ({ key, tasks }))
    };
    mkdirSync(path.dirname(historyFilePath), { recursive: true });
    const tempPath = `${historyFilePath}.tmp`;
    assertProtectedJsonWritable(historyFilePath);
    writeProtectedJsonFile(tempPath, payload);
    renameSync(tempPath, historyFilePath);
    recordPersistSuccess("task history");
  } catch (error) {
    // Reported, and never allowed to fail the request that finished the task.
    recordPersistFailure("task history", error);
  }
}

function stepFrom(event: ExecutionEvent): FinishedStep {
  return {
    kind: event.kind,
    label: clamp(event.label, 200),
    status: event.status,
    ...(event.detail ? { detail: clamp(event.detail, maxStepDetailLength) } : {}),
    ...(event.artifact ? { artifact: clamp(event.artifact, 300) } : {}),
    startedAt: event.startedAt,
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {})
  };
}

function copy(task: FinishedTask): FinishedTask {
  return { ...task, toolsUsed: [...task.toolsUsed], steps: task.steps.map((step) => ({ ...step })) };
}

/**
 * Keep a task as it ended.
 *
 * The status is the task's own unless one is given - "interrupted" is never a
 * stored task status, because a task that stopped without reporting cannot
 * say so itself. A task still planned or executing, with no status given, is
 * not finished and is not recorded.
 */
export function recordFinishedTask(
  key: string,
  task: StoredTask,
  events: ExecutionEvent[],
  options: { status?: FinishedStatus; error?: string; now?: Date } = {}
): FinishedTask | null {
  loadFromDisk();

  const status = options.status
    ?? (task.status === "succeeded" || task.status === "failed" || task.status === "blocked" ? task.status : null);
  if (!status) return null;

  const list = historyByKey.get(key) ?? [];
  const earlier = list.find((entry) => entry.id === task.id);
  const error = options.error ?? task.error;
  const record: FinishedTask = {
    id: task.id,
    request: clamp(task.request, maxTextLength),
    taskType: task.taskType,
    status,
    toolsUsed: task.toolsUsed.slice(-60),
    // A result belongs to a success and an error to anything else. A task
    // that was blocked and then resumed successfully still carries the old
    // error in taskStore; shown on the success, it would read as a failure.
    ...(status === "succeeded" && task.lastResult ? { result: clamp(task.lastResult, maxTextLength) } : {}),
    ...(status !== "succeeded" && error ? { error: clamp(error, maxTextLength) } : {}),
    startedAt: task.createdAt,
    finishedAt: (options.now ?? new Date()).toISOString(),
    steps: [...(earlier?.steps ?? []), ...events.map(stepFrom)].slice(-maxStepsPerTask)
  };

  // Delete then set: the session moves to the end of the map's order, so the
  // one evicted when there are too many is the one used least recently.
  historyByKey.delete(key);
  historyByKey.set(key, [record, ...list.filter((entry) => entry.id !== task.id)].slice(0, maxFinishedPerSession));
  while (historyByKey.size > maxTrackedHistorySessions) {
    const oldest = historyByKey.keys().next().value;
    if (oldest === undefined) break;
    historyByKey.delete(oldest);
  }

  saveToDisk();
  return copy(record);
}

/**
 * Before a new request replaces the session's task: if that task never
 * finished and nothing is running it, keep it as interrupted, rather than let
 * it be overwritten without a trace.
 */
export function archiveIfInterrupted(key: string, now: Date = new Date()): FinishedTask | null {
  const current = getTask(key);
  if (!current || isTaskRunning(key)) return null;
  if (current.status !== "planned" && current.status !== "executing") return null;
  return recordFinishedTask(key, current, [], {
    status: "interrupted",
    error: "It never finished. The app may have been closed or restarted while it ran.",
    now
  });
}

/** The steps the execution log saw from `since` on. */
export function stepsSince(key: string, since: string): ExecutionEvent[] {
  // ISO strings from one clock sort as they read. A scheduled run's log is
  // never cleared between runs, so the earlier runs' steps are left out.
  return listEvents(key).filter((event) => event.startedAt >= since);
}

/**
 * Run a task's work, marked as running for exactly as long as it is.
 *
 * A turn that threw used to leave its task "executing" for good - shown as
 * still running, and never recorded as having failed. It is now failed, with
 * the reason and the steps it got through, and the error still reaches the
 * caller exactly as before.
 */
export async function runTrackedTask<T>(key: string | undefined, startedAt: string, work: () => Promise<T>): Promise<T> {
  if (!key) return work();
  markTaskRunning(key, true);
  try {
    return await work();
  } catch (error) {
    const failed = updateTask(key, {
      status: "failed",
      error: error instanceof Error && error.message ? error.message : "The request failed before it finished."
    });
    if (failed) recordFinishedTask(key, failed, stepsSince(key, startedAt));
    throw error;
  } finally {
    markTaskRunning(key, false);
  }
}

export function listFinishedTasks(key: string): FinishedTask[] {
  loadFromDisk();
  return (historyByKey.get(key) ?? []).map(copy);
}

export function forgetFinishedTask(key: string, id: string): boolean {
  loadFromDisk();
  const list = historyByKey.get(key);
  if (!list?.some((entry) => entry.id === id)) return false;
  const next = list.filter((entry) => entry.id !== id);
  if (next.length > 0) historyByKey.set(key, next);
  else historyByKey.delete(key);
  saveToDisk();
  return true;
}

/** Empty the session's history; how many entries it held. */
export function clearFinishedTasks(key: string): number {
  loadFromDisk();
  const count = historyByKey.get(key)?.length ?? 0;
  if (count === 0) return 0;
  historyByKey.delete(key);
  saveToDisk();
  return count;
}

/** Test seam. */
export function resetTaskHistory(): void {
  loaded = true;
  historyByKey.clear();
  saveToDisk();
}

/** Test seam: drop in-process state and read the file again, as a restart would. */
export function reloadTaskHistoryFromDisk(): void {
  historyByKey.clear();
  loaded = false;
  loadFromDisk();
}
