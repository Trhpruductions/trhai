import test from "node:test";
import assert from "node:assert/strict";
import { evictableKey, isAccountKey } from "../src/services/storeEviction.js";

// When a per-person store holds too many keys, the oldest anonymous one goes and an
// account's never does: made-up guest ids must not push a real person's data off the disk.

process.env.ASSIST_CONVERSATION_PERSIST = "off";
process.env.ASSIST_MEMORY_PERSIST = "off";
process.env.ASSIST_KNOWLEDGE_PERSIST = "off";
process.env.ASSIST_TASKS_PERSIST = "off";
process.env.ASSIST_TASK_HISTORY_PERSIST = "off";

const conversations = await import("../src/services/conversationStore.js");
const memory = await import("../src/services/assistMemoryStore.js");
const knowledge = await import("../src/services/knowledgeStore.js");
const todos = await import("../src/services/taskListStore.js");
const history = await import("../src/services/taskHistory.js");
const tasks = await import("../src/services/taskStore.js");

const account = "user:0d4b4c1e-real-account";

test("the key let go of is the oldest that is not an account's; with only accounts, none", () => {
  assert.equal(evictableKey(["user:a", "guest-1", "guest-2"]), "guest-1");
  assert.equal(evictableKey(["guest-1", "user:a"]), "guest-1");
  assert.equal(evictableKey(["user:a", "user:b"]), undefined);
  assert.equal(evictableKey([]), undefined);
  assert.equal(isAccountKey("user:x"), true);
  assert.equal(isAccountKey("userx"), false);
});

test("conversations: an account made first survives five hundred guests made after it", () => {
  conversations.resetConversations();
  conversations.appendTurn(account, "user", "keep me");
  for (let index = 0; index < conversations.maxTrackedConversations; index += 1) conversations.appendTurn(`guest-${index}`, "user", `hello ${index}`);
  assert.equal(conversations.listConversations(account).length, 1, "the account's conversation is still there");
  assert.equal(conversations.listConversations("guest-0").length, 0, "the oldest guest's went instead");
  assert.equal(conversations.listConversations(`guest-${conversations.maxTrackedConversations - 1}`).length, 1);
});

test("memory: the same", () => {
  memory.resetAssistMemory();
  memory.recordSingleMemory(account, "I prefer tea over coffee");
  for (let index = 0; index < memory.maxTrackedSessions; index += 1) memory.recordSingleMemory(`guest-${index}`, `I prefer tea over coffee ${index}`);
  assert.equal(memory.listSessionMemories(account).length, 1);
  assert.equal(memory.listSessionMemories("guest-0").length, 0);
});

test("documents and to-dos: the same", () => {
  knowledge.resetKnowledge();
  knowledge.addDocument(account, { id: "keep", title: "Keep", body: "mine" });
  for (let index = 0; index < knowledge.maxTrackedKnowledgeSessions; index += 1) knowledge.addDocument(`guest-${index}`, { id: `d${index}`, title: `D${index}`, body: "x" });
  assert.equal(knowledge.listDocuments(account).length, 1);
  assert.equal(knowledge.listDocuments("guest-0").length, 0);

  todos.resetTasks();
  todos.addTask(account, { id: "keep", title: "Keep" });
  for (let index = 0; index < todos.maxTrackedTaskSessions; index += 1) todos.addTask(`guest-${index}`, { id: `t${index}`, title: `T${index}` });
  assert.equal(todos.listTasks(account).length, 1);
  assert.equal(todos.listTasks("guest-0").length, 0);
});

test("finished work: the same, at its smaller cap", () => {
  history.resetTaskHistory();
  tasks.resetTasks();
  const finish = (key: string) => {
    const task = tasks.recordTask(key, { request: "do a thing", taskType: "generic", status: "succeeded" });
    assert.ok(task);
    history.recordFinishedTask(key, task, [], { status: "succeeded" });
  };
  finish(account);
  for (let index = 0; index < history.maxTrackedHistorySessions; index += 1) finish(`guest-${index}`);
  assert.equal(history.listFinishedTasks(account).length, 1);
  assert.equal(history.listFinishedTasks("guest-0").length, 0);
});
