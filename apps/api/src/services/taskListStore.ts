import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// A to-do list for `/v1/tasks` — TRHAI's "Tasks" screen, not to be confused
// with taskStore.ts's StoredTask, which is a different thing under a
// similar name: one in-flight orchestrator job per session, resolved when a
// "continue" follow-up needs to know what it was mid-way through. A task
// here is something the user wrote down, however many they like, and
// nothing here is ever read by the orchestrator.
//
// Deliberately minimal: a title and whether it is done. The product vision
// mentions "Tasks" once, as an unelaborated word in a longer list — there is
// no spec for due dates, priority, or a status lifecycle beyond done/not
// done, and inventing one here would be a guess dressed up as a feature.
//
// Scoped per session, exactly like knowledge documents and saved memory, so
// an anonymous caller cannot read another's list.

export type TaskItem = {
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
};

/** Caps so an unauthenticated caller cannot grow storage without bound. */
export const maxTasksPerSession = 200;
export const maxTrackedTaskSessions = 500;

const tasksBySession = new Map<string, TaskItem[]>();

const taskListFilePath = process.env.ASSIST_TASKS_FILE
  ?? path.join(process.cwd(), "data", "assist-tasks.json");

let loaded = false;
let persistenceEnabled = process.env.ASSIST_TASKS_PERSIST !== "off";

type PersistedShape = {
  version: 1;
  sessions: Array<{ key: string; tasks: TaskItem[] }>;
};

function isTask(value: unknown): value is TaskItem {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<TaskItem>;
  return typeof entry.id === "string"
    && typeof entry.title === "string"
    && typeof entry.done === "boolean"
    && typeof entry.createdAt === "string";
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  if (!persistenceEnabled || !existsSync(taskListFilePath)) return;

  try {
    const parsed = JSON.parse(readFileSync(taskListFilePath, "utf8")) as Partial<PersistedShape>;
    if (!Array.isArray(parsed.sessions)) return;

    for (const session of parsed.sessions) {
      if (!session || typeof session.key !== "string" || !Array.isArray(session.tasks)) continue;
      const tasks = session.tasks.filter(isTask);
      if (tasks.length) tasksBySession.set(session.key, tasks);
    }
  } catch {
    // A corrupt file must never take the API down; start clean instead.
  }
}

function saveToDisk(): void {
  if (!persistenceEnabled) return;

  try {
    const payload: PersistedShape = {
      version: 1,
      sessions: [...tasksBySession.entries()].map(([key, tasks]) => ({ key, tasks }))
    };
    mkdirSync(path.dirname(taskListFilePath), { recursive: true });
    // Temp file then rename, so a crash mid-write cannot truncate the store.
    const tempPath = `${taskListFilePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tempPath, taskListFilePath);
  } catch {
    // Losing durability is bad; taking the request down with it is worse.
  }
}

export function listTasks(sessionKey: string): TaskItem[] {
  loadFromDisk();
  return [...(tasksBySession.get(sessionKey) ?? [])];
}

export function addTask(
  sessionKey: string,
  input: { id: string; title: string; createdAt?: string }
): TaskItem | null {
  loadFromDisk();

  const title = input.title.trim();
  if (!title) return null;

  const task: TaskItem = {
    id: input.id,
    title,
    done: false,
    createdAt: input.createdAt ?? new Date().toISOString()
  };

  const existing = tasksBySession.get(sessionKey) ?? [];
  const next = [...existing, task].slice(-maxTasksPerSession);
  tasksBySession.set(sessionKey, next);

  // Insertion-ordered map: dropping the first key evicts the least recent session.
  if (tasksBySession.size > maxTrackedTaskSessions) {
    const oldest = tasksBySession.keys().next().value;
    if (oldest !== undefined) tasksBySession.delete(oldest);
  }

  saveToDisk();
  return task;
}

export function setTaskDone(sessionKey: string, taskId: string, done: boolean): TaskItem | null {
  loadFromDisk();
  const existing = tasksBySession.get(sessionKey);
  if (!existing) return null;

  const index = existing.findIndex((task) => task.id === taskId);
  if (index === -1) return null;

  const updated: TaskItem = { ...existing[index], done };
  const next = [...existing];
  next[index] = updated;
  tasksBySession.set(sessionKey, next);
  saveToDisk();
  return updated;
}

export function removeTask(sessionKey: string, taskId: string): boolean {
  loadFromDisk();
  const existing = tasksBySession.get(sessionKey);
  if (!existing) return false;

  const next = existing.filter((task) => task.id !== taskId);
  if (next.length === existing.length) return false;

  tasksBySession.set(sessionKey, next);
  saveToDisk();
  return true;
}

export function resetTasks(sessionKey?: string): void {
  if (sessionKey) {
    tasksBySession.delete(sessionKey);
  } else {
    tasksBySession.clear();
  }
  saveToDisk();
}

export function setTaskPersistence(enabled: boolean): void {
  persistenceEnabled = enabled;
}
