import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeEngine, type ScriptedReply } from "./helpers/fakeEngine.js";

// Found on the graphics card on 2026-11-05: the model answered "Task added" and "Reminder added" having
// called nothing, and asked for an audio file it overwrote notes.txt. When a request plainly asks for one
// kind of thing, only its tools are on offer, the general writers are out of reach, and a reply with
// nothing done does not get to say it was.

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-required-"));
process.env.ASCEND_WORKSPACE = workspace;
process.env.ASSIST_TASKS_PERSIST = "off";
const { runAgent } = await import("../src/services/agentLoop.js");
const { actionAskedFor, actedOn, narrowForAction, notDoneReply } = await import("../src/services/requiredAction.js");
const { wantsTodo } = await import("../src/services/actionIntent.js");
const { todoAccessFor } = await import("../src/services/todoTools.js");
const { listTasks, resetTasks } = await import("../src/services/taskListStore.js");

test.after(() => rmSync(workspace, { recursive: true, force: true }));

const key = "required-session";
const named = (...names: string[]) => names.map((name) => ({ function: { name } }));
const namesOf = (tools: Array<{ function: { name: string } }> | undefined) => (tools ?? []).map((tool) => tool.function.name);

async function run(question: string, replies: ScriptedReply[]) {
  const engine = await fakeEngine({ models: ["llama3.1-8b"], reply: replies });
  const config = { baseUrl: engine.baseUrl, model: "llama3.1:8b", modelFromEnv: true, timeoutMs: 5000 };
  try {
    const result = await runAgent(config, question, { memories: [], knowledge: [], request: question, todo: todoAccessFor(key) } as never);
    return { result, engine };
  } finally {
    engine.server.close();
  }
}

test("each plain request maps to the tools that do it, and anything else to nothing", () => {
  const family = (question: string) => actionAskedFor(question)?.tools;
  assert.deepEqual(family("remind me tomorrow at 3 pm to call the bank"), ["add_schedule"]);
  assert.ok(family("add buy milk to my to-do list")?.includes("add_task"));
  assert.ok(family("remind me to call the bank")?.includes("add_task"), "no time said: a task");
  assert.ok(family("put the dentist on my calendar on Friday at 2 pm")?.includes("add_event"));
  assert.deepEqual(family("transcribe meeting.mp3"), ["transcribe_file"]);
  assert.deepEqual(family("read this to a wav file: hello there"), ["speak_to_file"]);
  assert.deepEqual(family("convert song.wav to mp3"), ["convert_media"]);
  assert.ok(family("make me a Word document of the plan")?.includes("make_document"));
  for (const other of ["hello", "what is the capital of Australia?", "open my todo app", "explain what a calendar is", "build me a to-do app"]) {
    assert.equal(actionAskedFor(other), null, other);
  }
  assert.equal(wantsTodo("open my todo app"), false, "an app is not the list");
});

test("until it has acted only that family is on offer, then the writers stay out unless the request names a file", () => {
  const offered = named("add_task", "list_tasks", "current_datetime", "write_file", "edit_file", "run_command", "read_file");
  const family = { tools: ["add_task", "list_tasks"], lookups: ["current_datetime"] };
  const before = narrowForAction(offered, family, false);
  assert.equal(before.onlyTheFamily, true);
  assert.deepEqual(namesOf(before.tools), ["add_task", "list_tasks", "current_datetime"]);
  const after = narrowForAction(offered, family, true);
  assert.equal(after.onlyTheFamily, false);
  assert.deepEqual(namesOf(after.tools), ["add_task", "list_tasks", "current_datetime", "read_file"]);
  assert.ok(namesOf(narrowForAction(offered, family, true, true).tools).includes("write_file"));
  // Not on offer at all, as in a turn that may not write: nothing to require.
  assert.equal(narrowForAction(named("read_file"), family, false).onlyTheFamily, false);
  assert.equal(actedOn(family, [{ name: "current_datetime" }]), false, "looking something up is not doing it");
  assert.equal(actedOn(family, [{ name: "add_task" }]), true);
});

test("only the family is on offer until it has acted, and the engine is never told a call is required", async () => {
  resetTasks();
  const { result, engine } = await run("add buy milk to my to-do list", [
    { message: { content: "", tool_calls: [{ function: { name: "add_task", arguments: { title: "Buy milk" } } }] } },
    { message: { content: "Done." } }
  ]);
  const first = engine.chats[0] as unknown as { tool_choice?: string; tools: Array<{ function: { name: string } }> };
  const second = engine.chats[1] as unknown as { tool_choice?: string; tools?: Array<{ function: { name: string } }> };
  // On the real model that setting stops the reply from ever ending; see requiredAction.ts.
  assert.equal(first.tool_choice, undefined);
  assert.deepEqual(namesOf(first.tools).sort(), ["add_task", "complete_task", "list_tasks", "remove_task"]);
  assert.equal(second.tool_choice, undefined);
  assert.equal(namesOf(second.tools).includes("write_file"), false);
  assert.deepEqual(listTasks(key).map((task) => task.title), ["Buy milk"]);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.text, /Added to your tasks: Buy milk/);
});

test("an ordinary question keeps everything it was offered", async () => {
  const { result, engine } = await run("what is the capital of Australia?", [{ message: { content: "Canberra." } }]);
  assert.equal(engine.chats.length, 1);
  if (result.ok) assert.equal(result.text, "Canberra.");
});

test("a model that says it added something and called nothing is told so, and then the person is told the truth", async () => {
  resetTasks();
  const { result, engine } = await run("add buy milk to my to-do list", [
    { message: { content: "Task added to your to-do list: buy milk." } },
    { message: { content: "Task added to your to-do list: buy milk." } }
  ]);
  assert.equal(engine.chats.length, 2, "told once");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, notDoneReply);
    assert.doesNotMatch(result.text, /Task added/);
  }
  assert.deepEqual(listTasks(key), []);
});

test("told once, a model that then does it is believed", async () => {
  resetTasks();
  const { result } = await run("add buy milk to my to-do list", [
    { message: { content: "Task added." } },
    { message: { content: "", tool_calls: [{ function: { name: "add_task", arguments: { title: "Buy milk" } } }] } },
    { message: { content: "Done." } }
  ]);
  assert.deepEqual(listTasks(key).map((task) => task.title), ["Buy milk"]);
  if (result.ok) assert.match(result.text, /Added to your tasks: Buy milk/);
});

test("asked for an audio file, a model that writes over another file cannot", async () => {
  const notes = path.join(workspace, "notes.txt");
  writeFileSync(notes, "the quick brown fox");
  const { result } = await run("Read this to a wav file called Spoken: The meeting is moved.", [
    { message: { content: "", tool_calls: [{ function: { name: "write_file", arguments: { path: "notes.txt", content: "The meeting is moved." } } }] } },
    { message: { content: "Saved." } },
    { message: { content: "Saved." } }
  ]);
  assert.equal(readFileSync(notes, "utf8"), "the quick brown fox");
  assert.equal(existsSync(notes), true);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.toolsUsed.filter((used) => used.name === "write_file" && used.ok), []);
});

test("a plain question about the list that the model will not act on is read for it", async () => {
  resetTasks();
  const { addTask } = await import("../src/services/taskListStore.js");
  addTask(key, { id: "milk", title: "Buy milk" });
  const { result } = await run("what's on my to-do list?", [
    { message: { content: "Here is your list: 1. Walk the dog" } },
    { message: { content: "Here is your list: 1. Walk the dog" } }
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.text, /Buy milk/);
    assert.doesNotMatch(result.text, /Walk the dog/, "the list, not the model's invention");
    assert.deepEqual(result.toolsUsed.map((used) => used.name), ["list_tasks"]);
  }
  // A change is never made for it.
  const { readInstead } = await import("../src/services/requiredAction.js");
  const family = { tools: ["list_tasks", "add_task", "complete_task", "remove_task"], lookups: [] };
  assert.equal(readInstead(family, "what's on my to-do list?"), "list_tasks");
  assert.equal(readInstead(family, "add buy milk to my to-do list"), null);
  assert.equal(readInstead(family, "tick off buy milk"), null);
  assert.equal(readInstead({ tools: ["list_events", "add_event", "remove_event"], lookups: [] }, "what's on my calendar?"), "list_events");
  assert.equal(readInstead({ tools: ["speak_to_file"], lookups: [] }, "what can you read aloud?"), null);
});

test("the assistant keeps its own name, whatever a model calls itself", async () => {
  const { inOwnName } = await import("../src/services/requiredAction.js");
  assert.match(inOwnName("Hello! I'm Claude, an AI assistant designed to help."), /^Hello! I'm TRH AI designed to help\.$/);
  assert.equal(inOwnName("I am ChatGPT, an AI model developed by OpenAI."), "I am TRH AI.");
  assert.equal(inOwnName("My name is Gemini."), "My name is TRH AI.");
  assert.equal(inOwnName("Claude Monet painted water lilies; I'm TRH AI."), "Claude Monet painted water lilies; I'm TRH AI.", "a name that is not the assistant's is left alone");
});
