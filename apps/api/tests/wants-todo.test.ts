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

test("a reminder that says when is for that moment - a schedule - and one that does not is a task", () => {
  for (const request of [
    "remind me to call the bank at 3 pm",
    "remind me to call the bank at 3pm tomorrow",
    "Remind me at 15:30 to call the bank",
    "remind me at three o'clock to call the bank",
    "remind me to take the roast out at noon",
    "remind me to call the bank in 20 minutes",
    "remind me in an hour to check the oven",
    "remind me in half an hour to stretch",
    "remind me around 9 a.m. to ring the school"
  ]) {
    assert.equal(wantsTodo(request), false, request);
  }
  // A time that is part of the thing to do, a deadline, or a day with no time: still a task.
  for (const request of [
    "remind me to call the bank",
    "remind me to call the bank tomorrow",
    "remind me to call the bank about the 3pm appointment",
    "remind me to catch the 9:15 train",
    "remind me to send the form by 5 pm",
    "remind me to buy 2 litres of milk",
    "note to self: the dentist is at 3 pm on Friday"
  ]) {
    assert.equal(wantsTodo(request), true, request);
  }
});
