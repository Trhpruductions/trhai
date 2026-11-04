import { addTask, listTasks, removeTask, setTaskDone, type TaskItem } from "./taskListStore.js";

// The assistant's hands on the Tasks screen's list: the to-dos a person wrote down
// (taskListStore.ts), scoped to their session or account exactly as the screen is.
//
// The Home screen has said "ask TRH AI to add a task" since the list existed, and nothing
// answered: the list had routes and a screen, and the assistant had no tool for it, so the
// request got a reply and no task. These are the four things a person does with such a list -
// read it, add to it, tick something off, take something off - and nothing more: the list is
// a title and whether it is done, on purpose (see the store).
//
// A task is named by its number in the list as it was last shown, or by its words. The number
// is the position in the whole list, done ones included, so ticking one off moves none of the
// others.

/** What the tools are given: the list behind /v1/tasks for one caller, the key kept out of here. */
export type TodoAccess = {
  list: () => TaskItem[];
  add: (title: string) => TaskItem | null;
  setDone: (id: string, done: boolean) => TaskItem | null;
  remove: (id: string) => boolean;
};

/** The list for one caller, with ids made the way the route makes them. */
export function todoAccessFor(sessionKey: string): TodoAccess {
  return {
    list: () => listTasks(sessionKey),
    add: (title) => addTask(sessionKey, { id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title }),
    setDone: (id, done) => setTaskDone(sessionKey, id, done),
    remove: (id) => removeTask(sessionKey, id)
  };
}

/** A task is one short line; a paragraph is not a task, and the screen has one line for it. */
export const maxTaskLength = 200;

export type TaskScope = "open" | "done" | "all";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Words, lower-cased, with punctuation and runs of space flattened - so "Buy milk!" is "buy milk". */
export function sameTask(a: string, b: string): boolean {
  return flatten(a) === flatten(b);
}

function flatten(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The list as the model and the user see it: numbered in order, the done ones ticked. */
export function describeTasks(tasks: TaskItem[], scope: TaskScope = "all"): string {
  if (tasks.length === 0) return "The task list is empty.";
  const numbered = tasks.map((task, index) => ({ task, number: index + 1 }));
  const shown = numbered.filter(({ task }) => scope === "all" || (scope === "done") === task.done);
  const open = tasks.filter((task) => !task.done).length;
  if (shown.length === 0) {
    if (scope === "done") return "Nothing is done yet.";
    return tasks.length === 1 ? "Nothing is open: the one task is done." : `Nothing is open: all ${tasks.length} tasks are done.`;
  }
  const head = scope === "all"
    ? `${plural(tasks.length, "task")}, ${open} open:`
    : scope === "open" ? `${plural(shown.length, "open task")}:` : `${plural(shown.length, "task")} done:`;
  return [head, ...shown.map(({ task, number }) => `${number}. [${task.done ? "x" : " "}] ${task.title}`)].join("\n");
}

export type TaskLookup =
  | { kind: "one"; task: TaskItem; number: number }
  | { kind: "several"; matches: Array<{ task: TaskItem; number: number }> }
  | { kind: "none" };

/**
 * A task by its number in the list ("2", "#2", "2."), or by its words: the task whose title
 * is those words, else the one task whose title contains them. Several that match are
 * handed back for the user to choose between; none is said, never guessed.
 */
export function findTask(tasks: TaskItem[], reference: string): TaskLookup {
  const ref = reference.trim();
  if (!ref) return { kind: "none" };
  const numbered = tasks.map((task, index) => ({ task, number: index + 1 }));
  const asNumber = /^#?(\d{1,3})\.?$/.exec(ref);
  if (asNumber) {
    const hit = numbered[Number(asNumber[1]) - 1];
    return hit ? { kind: "one", ...hit } : { kind: "none" };
  }
  const wanted = flatten(ref);
  if (!wanted) return { kind: "none" };
  const exact = numbered.filter(({ task }) => flatten(task.title) === wanted);
  if (exact.length === 1) return { kind: "one", ...exact[0] };
  if (exact.length > 1) return { kind: "several", matches: exact };
  const partial = numbered.filter(({ task }) => flatten(task.title).includes(wanted));
  if (partial.length === 1) return { kind: "one", ...partial[0] };
  if (partial.length > 1) return { kind: "several", matches: partial };
  return { kind: "none" };
}
