import test from "node:test";
import assert from "node:assert/strict";
import {
  addTask,
  listTasks,
  maxTasksPerSession,
  removeTask,
  resetTasks,
  setTaskDone,
  setTaskPersistence
} from "../src/services/taskListStore.js";

setTaskPersistence(false);

function freshSession(name: string): string {
  const key = `${name}-${Math.random().toString(36).slice(2)}`;
  resetTasks(key);
  return key;
}

test("a task is stored, not done by default, and listed", () => {
  const session = freshSession("store");
  const task = addTask(session, { id: "t1", title: "Write the changelog" });

  assert.ok(task);
  assert.equal(task.title, "Write the changelog");
  assert.equal(task.done, false);
  assert.deepEqual(listTasks(session).map((entry) => entry.id), ["t1"]);
});

test("a task with no title, or only whitespace, is refused", () => {
  const session = freshSession("invalid");

  assert.equal(addTask(session, { id: "a", title: "" }), null);
  assert.equal(addTask(session, { id: "b", title: "   " }), null);
  assert.deepEqual(listTasks(session), []);
});

test("a title is trimmed before it is stored", () => {
  const session = freshSession("trim");
  const task = addTask(session, { id: "t1", title: "  Ship it  " });

  assert.equal(task?.title, "Ship it");
});

test("tasks are scoped to their session", () => {
  const mine = freshSession("mine");
  const yours = freshSession("yours");

  addTask(mine, { id: "t1", title: "Mine" });

  assert.deepEqual(listTasks(mine).map((entry) => entry.title), ["Mine"]);
  assert.deepEqual(listTasks(yours), []);
});

test("marking a task done updates it in place, and can be undone", () => {
  const session = freshSession("done");
  const task = addTask(session, { id: "t1", title: "Deploy" });
  assert.ok(task);

  const done = setTaskDone(session, task.id, true);
  assert.equal(done?.done, true);
  assert.equal(listTasks(session)[0].done, true);

  const undone = setTaskDone(session, task.id, false);
  assert.equal(undone?.done, false);
});

test("marking an unknown task, or one in a different session, does nothing", () => {
  const session = freshSession("unknown");
  addTask(session, { id: "t1", title: "Real task" });

  assert.equal(setTaskDone(session, "nonexistent", true), null);
  assert.equal(setTaskDone(freshSession("elsewhere"), "t1", true), null);
});

test("removing a task takes it out of the list; removing it again reports nothing changed", () => {
  const session = freshSession("remove");
  const task = addTask(session, { id: "t1", title: "Temporary" });
  assert.ok(task);

  assert.equal(removeTask(session, task.id), true);
  assert.deepEqual(listTasks(session), []);
  assert.equal(removeTask(session, task.id), false);
});

test("a session cannot grow past the per-session cap", () => {
  const session = freshSession("cap");
  for (let i = 0; i < maxTasksPerSession + 10; i += 1) {
    addTask(session, { id: `t${i}`, title: `Task ${i}` });
  }

  assert.equal(listTasks(session).length, maxTasksPerSession);
  // The oldest were evicted, not the newest — the list keeps what was most
  // recently added.
  assert.equal(listTasks(session).at(-1)?.title, `Task ${maxTasksPerSession + 9}`);
});
