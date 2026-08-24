import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// What the assistant is part-way through, so "do it" has something to resume.
//
// The gap this fills: the request analyser already recognises "continue",
// "do it", "go ahead" as commands, but nothing was recorded for them to
// continue. A continuation therefore arrived as a two-word message with no
// content words, hit the composer's vague branch, and got "I need a bit more
// to work with" — asking the user to re-explain the thing they had just
// asked for.
//
// One task per session, not a queue. "Continue" means the last thing, and a
// backlog nobody asked for would raise the question of which task it meant.
//
// Status is recorded rather than inferred, and only ever set from what
// actually happened. The whole point is that a task which could not run says
// "blocked" and names the reason, instead of being quietly forgotten and
// leaving the user to assume it worked.

/**
 * Where a task actually got to.
 *
 * "executing" is a real stored state rather than a transient one: a process
 * that dies mid-task leaves it there, and that is exactly the case where a
 * resume is most useful, so it stays resumable rather than being cleaned up
 * as garbage.
 */
export type TaskStatus = "planned" | "executing" | "succeeded" | "failed" | "blocked";

export type StoredTask = {
  id: string;
  status: TaskStatus;
  /** The user's own words. This is what a continuation re-runs. */
  request: string;
  /** From detectTaskType: create, fix, test, deploy, analyze, and so on. */
  taskType: string;
  /** Tools that genuinely ran for this task, in order, across resumes. */
  toolsUsed: string[];
  /** The last thing the assistant actually reported for this task. */
  lastResult?: string;
  /** Why it stopped, when it did not succeed. Never a guess. */
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export const maxTrackedTasks = 500;
/**
 * How long a task stays resumable.
 *
 * A "do it" a week after the fact almost certainly means something else, and
 * resuming a stale task is worse than admitting there is nothing pending.
 */
export const maxTaskAgeMs = 24 * 60 * 60 * 1000;
const maxRequestLength = 4000;
const maxResultLength = 4000;

const taskFilePath = process.env.ASSIST_TASK_FILE
  ?? path.join(process.cwd(), "data", "tasks.json");

const persistenceEnabled = process.env.ASSIST_TASK_PERSIST !== "off";
let loaded = false;

const taskByKey = new Map<string, StoredTask>();

const statuses: TaskStatus[] = ["planned", "executing", "succeeded", "failed", "blocked"];

function isStoredTask(value: unknown): value is StoredTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<StoredTask>;

  return typeof task.id === "string"
    && typeof task.status === "string"
    && statuses.includes(task.status as TaskStatus)
    && typeof task.request === "string"
    && typeof task.taskType === "string"
    && Array.isArray(task.toolsUsed)
    && task.toolsUsed.every((tool) => typeof tool === "string")
    && typeof task.createdAt === "string"
    && typeof task.updatedAt === "string"
    && (task.lastResult === undefined || typeof task.lastResult === "string")
    && (task.error === undefined || typeof task.error === "string");
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(taskFilePath)) return;

  try {
    const parsed = JSON.parse(readFileSync(taskFilePath, "utf8")) as {
      tasks?: Array<{ key?: unknown; task?: unknown }>;
    };

    for (const entry of parsed.tasks ?? []) {
      if (!entry || typeof entry.key !== "string") continue;
      if (isStoredTask(entry.task)) taskByKey.set(entry.key, entry.task);
    }
  } catch {
    // A corrupt file must not take the API down.
  }
}

function saveToDisk(): void {
  if (!persistenceEnabled) return;
  try {
    const payload = {
      version: 1,
      tasks: [...taskByKey.entries()].map(([key, task]) => ({ key, task }))
    };
    mkdirSync(path.dirname(taskFilePath), { recursive: true });
    const tempPath = `${taskFilePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tempPath, taskFilePath);
  } catch {
    // Durability loss must not fail the request.
  }
}

function evictOldestIfNeeded(): void {
  while (taskByKey.size > maxTrackedTasks) {
    const oldest = taskByKey.keys().next().value;
    if (oldest === undefined) return;
    taskByKey.delete(oldest);
  }
}

function clamp(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Record the work this turn started, replacing whatever was pending.
 *
 * Replacing rather than queueing: a new request supersedes the old one, and
 * the alternative — a growing list — would make "continue" ambiguous.
 */
export function recordTask(
  key: string,
  input: { request: string; taskType: string; status?: TaskStatus }
): StoredTask | null {
  loadFromDisk();

  const request = typeof input.request === "string" ? input.request.trim() : "";
  if (!request) return null;

  const now = new Date().toISOString();
  const task: StoredTask = {
    id: globalThis.crypto.randomUUID(),
    status: input.status ?? "planned",
    request: clamp(request, maxRequestLength),
    taskType: input.taskType,
    toolsUsed: [],
    createdAt: now,
    updatedAt: now
  };

  taskByKey.set(key, task);
  evictOldestIfNeeded();
  saveToDisk();

  return task;
}

/**
 * Update the pending task with what actually happened.
 *
 * Tools accumulate across resumes rather than being replaced, so a task
 * resumed twice reports everything it ran, not only the last attempt.
 */
export function updateTask(
  key: string,
  update: { status?: TaskStatus; toolsUsed?: string[]; lastResult?: string; error?: string }
): StoredTask | null {
  loadFromDisk();

  const existing = taskByKey.get(key);
  if (!existing) return null;

  const next: StoredTask = {
    ...existing,
    ...(update.status ? { status: update.status } : {}),
    ...(update.toolsUsed?.length ? { toolsUsed: [...existing.toolsUsed, ...update.toolsUsed] } : {}),
    ...(update.lastResult !== undefined ? { lastResult: clamp(update.lastResult, maxResultLength) } : {}),
    ...(update.error !== undefined ? { error: clamp(update.error, maxResultLength) } : {}),
    updatedAt: new Date().toISOString()
  };

  taskByKey.set(key, next);
  saveToDisk();

  return next;
}

/** The task as stored, whatever its state. */
export function getTask(key: string): StoredTask | null {
  loadFromDisk();
  return taskByKey.get(key) ?? null;
}

/**
 * The task a continuation should resume, or null.
 *
 * Null is a real answer and the caller must respect it: "do it" with nothing
 * resumable has to ask what to do, never invent a task to look responsive.
 */
export function getResumableTask(key: string, now: Date = new Date()): StoredTask | null {
  loadFromDisk();

  const task = taskByKey.get(key);
  if (!task) return null;

  // Finished work is not resumable. "Do it" after a completed task is a new
  // request, not a repeat of the last one.
  if (task.status === "succeeded") return null;

  const age = now.getTime() - new Date(task.updatedAt).getTime();
  if (!Number.isFinite(age) || age > maxTaskAgeMs) return null;

  return task;
}

export function clearTask(key: string): boolean {
  loadFromDisk();
  if (!taskByKey.has(key)) return false;

  taskByKey.delete(key);
  saveToDisk();
  return true;
}

/** Test seam. */
export function resetTasks(): void {
  loaded = true;
  taskByKey.clear();
  saveToDisk();
}

/** Test seam: drop in-process state and re-read the file, simulating a restart. */
export function reloadTasksFromDisk(): void {
  taskByKey.clear();
  loaded = false;
  loadFromDisk();
}
