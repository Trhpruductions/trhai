import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "trhai-todo-"));
process.env.ASSIST_TASKS_PERSIST = "off";
const { runTool } = await import("../src/services/agentTools.js");
const { resetTasks, listTasks } = await import("../src/services/taskListStore.js");
const { describeTasks, findTask, todoAccessFor, maxTaskLength } = await import("../src/services/todoTools.js");

// The Home screen says "ask TRH AI to add a task"; until now the assistant had no way to.
// These are the four things a person does with the Tasks screen's list, through the tools,
// against the real store (persistence off), scoped to one caller.

const key = "todo-test-session";
// Removing asks the user first (level 3, like forget and delete_document); here the user has said yes.
const context = () => ({ memories: [], knowledge: [], todo: todoAccessFor(key), confirmedActions: new Set(["remove_task"]) });

test("an empty list says so, rather than denying the feature", async () => {
  resetTasks();
  const result = await runTool({ name: "list_tasks", arguments: {} }, context());
  assert.equal(result.ok, true);
  assert.match(result.content, /empty/i);
});

test("a task is added, in the user's words, and is really on the list", async () => {
  resetTasks();
  const added = await runTool({ name: "add_task", arguments: { title: "Buy milk" } }, context());
  assert.equal(added.ok, true, added.content);
  assert.match(added.content, /Added to your tasks: Buy milk/);
  assert.deepEqual(listTasks(key).map((task) => [task.title, task.done]), [["Buy milk", false]]);
  // Another caller's list is another list.
  assert.deepEqual(listTasks("someone-else"), []);
});

test("several tasks at once, one per line, in the order given; one already on the list is said, not added twice", async () => {
  resetTasks();
  const added = await runTool({ name: "add_task", arguments: { title: "- Call the bank\n2. Book the dentist\n  " } }, context());
  assert.equal(added.ok, true, added.content);
  assert.match(added.content, /Added 2 tasks:\n- Call the bank\n- Book the dentist/);
  const again = await runTool({ name: "add_task", arguments: { title: "call the bank!" } }, context());
  assert.equal(again.ok, true, "already there is a success with nothing left to do, so the model does not reword it");
  assert.match(again.content, /Already on the list: call the bank!/);
  assert.equal(listTasks(key).length, 2);
});

test("nothing to add, or a paragraph instead of a line, is refused and nothing is added", async () => {
  resetTasks();
  const empty = await runTool({ name: "add_task", arguments: {} }, context());
  assert.equal(empty.ok, false);
  assert.match(empty.content, /needs the task/);
  const long = await runTool({ name: "add_task", arguments: { title: "x".repeat(maxTaskLength + 1) } }, context());
  assert.equal(long.ok, false);
  assert.match(long.content, /one short line/);
  assert.equal(listTasks(key).length, 0);
});

test("the list is numbered, the done ones ticked, and the numbers hold when one is ticked off", async () => {
  resetTasks();
  const todo = todoAccessFor(key);
  for (const title of ["Buy milk", "Call the bank", "Water the plants"]) todo.add(title);
  const done = await runTool({ name: "complete_task", arguments: { task: "2" } }, context());
  assert.equal(done.ok, true, done.content);
  assert.match(done.content, /^Done: Call the bank$/);

  const all = await runTool({ name: "list_tasks", arguments: { which: "all" } }, context());
  assert.equal(all.content, "3 tasks, 2 open:\n1. [ ] Buy milk\n2. [x] Call the bank\n3. [ ] Water the plants");
  const open = await runTool({ name: "list_tasks", arguments: { which: "open" } }, context());
  assert.equal(open.content, "2 open tasks:\n1. [ ] Buy milk\n3. [ ] Water the plants", "the number is the place in the whole list");
  const finished = await runTool({ name: "list_tasks", arguments: { which: "done" } }, context());
  assert.equal(finished.content, "1 task done:\n2. [x] Call the bank");

  // Ticked off again: nothing to do, and said so rather than claimed as a change.
  const twice = await runTool({ name: "complete_task", arguments: { task: "2" } }, context());
  assert.equal(twice.ok, true);
  assert.match(twice.content, /Already done: Call the bank/);
  // And opened again.
  const reopened = await runTool({ name: "complete_task", arguments: { task: "call the bank", done: false } }, context());
  assert.match(reopened.content, /Open again: Call the bank/);
  assert.equal(listTasks(key)[1].done, false);
});

test("a task is found by its words - exactly, or as the one that contains them - and never guessed between several", async () => {
  resetTasks();
  const todo = todoAccessFor(key);
  for (const title of ["Buy milk", "Buy bread", "Call Sam about the milk run"]) todo.add(title);
  const byWords = await runTool({ name: "complete_task", arguments: { task: "buy bread" } }, context());
  assert.match(byWords.content, /^Done: Buy bread$/);
  const ambiguous = await runTool({ name: "complete_task", arguments: { task: "milk" } }, context());
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.content, /could mean any of these/);
  assert.match(ambiguous.content, /1\. Buy milk/);
  assert.match(ambiguous.content, /3\. Call Sam about the milk run/);
  assert.equal(listTasks(key).filter((task) => task.done).length, 1, "nothing else was ticked");
  const none = await runTool({ name: "complete_task", arguments: { task: "walk the dog" } }, context());
  assert.equal(none.ok, false);
  assert.match(none.content, /No task matches "walk the dog"/);
  assert.match(none.content, /1\. \[ \] Buy milk/, "the list is shown so the next call can name one");
});

test("removing takes the task off for good; a number past the end is nothing", async () => {
  resetTasks();
  const todo = todoAccessFor(key);
  todo.add("Buy milk");
  todo.add("Call the bank");
  const removed = await runTool({ name: "remove_task", arguments: { task: "#1" } }, context());
  assert.equal(removed.ok, true, removed.content);
  assert.match(removed.content, /Removed from your tasks: Buy milk/);
  assert.deepEqual(listTasks(key).map((task) => task.title), ["Call the bank"]);
  const gone = await runTool({ name: "remove_task", arguments: { task: "9" } }, context());
  assert.equal(gone.ok, false);
  assert.match(gone.content, /No task matches "9"/);
  const nothing = await runTool({ name: "remove_task", arguments: {} }, context());
  assert.equal(nothing.ok, false);
  assert.match(nothing.content, /needs the task's number/);
});

test("without a list to reach, each tool says so instead of pretending", async () => {
  resetTasks();
  const bare = { memories: [], knowledge: [], confirmedActions: new Set(["remove_task"]) };
  for (const [name, args] of [["list_tasks", {}], ["add_task", { title: "x" }], ["complete_task", { task: "1" }], ["remove_task", { task: "1" }]] as const) {
    const result = await runTool({ name, arguments: args }, bare);
    assert.equal(result.ok, false, name);
    assert.match(result.content, /no task list here/i, name);
  }
});

test("the pure parts: describing and finding", () => {
  const tasks = [
    { id: "a", title: "Buy milk", done: false, createdAt: "2026-11-03T00:00:00.000Z" },
    { id: "b", title: "Buy bread", done: true, createdAt: "2026-11-03T00:00:00.000Z" }
  ];
  assert.equal(describeTasks([]), "The task list is empty.");
  assert.equal(describeTasks(tasks, "open"), "1 open task:\n1. [ ] Buy milk");
  assert.equal(describeTasks([tasks[1]], "open"), "Nothing is open: the one task is done.");
  assert.equal(describeTasks([tasks[1], tasks[1]], "open"), "Nothing is open: all 2 tasks are done.");
  assert.equal(describeTasks([tasks[0]], "done"), "Nothing is done yet.");
  assert.deepEqual(findTask(tasks, "2."), { kind: "one", task: tasks[1], number: 2 });
  assert.deepEqual(findTask(tasks, "BUY MILK"), { kind: "one", task: tasks[0], number: 1 });
  assert.equal(findTask(tasks, "buy").kind, "several");
  assert.equal(findTask(tasks, "").kind, "none");
  assert.equal(findTask(tasks, "!!!").kind, "none", "words with no letters in them match nothing");
});
