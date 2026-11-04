import test from "node:test";
import assert from "node:assert/strict";
import { wantsTodo } from "../src/services/actionIntent.js";

// When a request is about the user's own to-do list, so the task tools are worth offering -
// and when it only has the word "task" in it.

test("asking to add to, see, tick off or clear the to-do list is recognised", () => {
  for (const request of [
    "add buy milk to my to-do list",
    "Add a task: call the dentist tomorrow",
    "put 'renew the car insurance' on my list",
    "note to self: send the invoice",
    "jot down on my to-do list: pick up the parcel",
    "remind me to call the bank",
    "don't let me forget to water the plants",
    "what's on my to-do list?",
    "what do I have to do today",
    "show me my tasks",
    "anything left to do?",
    "list my open tasks",
    "mark the milk one as done",
    "tick off call the dentist",
    "I finished the report, cross it off",
    "I've done the shopping task",
    "remove the dentist task",
    "delete 'buy milk' from my list",
    "clear my done tasks",
    "what have I got left on my list"
  ]) {
    assert.equal(wantsTodo(request), true, request);
  }
});

test("a task app, the Task Manager, the assistant's own work and a plain question are not the to-do list", () => {
  for (const request of [
    "build me a task app",
    "I need a task tracker with a database",
    "open Task Manager and see what is using memory",
    "which scheduled tasks are running on this PC?",
    "what are you working on right now",
    "remind me every day at 9 to stretch",
    "how do I prioritise tasks at work?",
    "write a poem about a list of chores",
    "explain what a checklist is",
    "hello"
  ]) {
    assert.equal(wantsTodo(request), false, request);
  }
});
