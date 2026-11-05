import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeEngine } from "./helpers/fakeEngine.js";

// "Remind me to call the bank" is something to do: a task on the list. "Remind me to call the bank at 3 pm" is for a
// moment: a schedule that runs once and shows the words when it does. The two are different tools, and which one a
// request is handed is decided here from its own words - through the loop, so what is checked is what the model is
// actually offered, with the rest of the gating in the way.

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-reminder-or-task-"));
process.env.ASCEND_WORKSPACE = workspace;
const { runAgent } = await import("../src/services/agentLoop.js");

test.after(() => { rmSync(workspace, { recursive: true, force: true }); });

async function offeredFor(question: string): Promise<string[]> {
  const engine = await fakeEngine({ models: ["llama3.1-8b"], reply: [{ message: { content: "Sure." } }] });
  const config = { baseUrl: engine.baseUrl, model: "llama3.1:8b", modelFromEnv: true, timeoutMs: 5000 };
  try {
    await runAgent(config, question, { memories: [], knowledge: [] });
    return (engine.chats[0]?.tools ?? []).map((entry) => entry.function.name);
  } finally {
    engine.server.close();
  }
}

test("a reminder with no time in it is handed the to-do list", async () => {
  for (const question of ["remind me to call the bank", "don't let me forget to water the plants", "add buy milk to my to-do list"]) {
    const offered = await offeredFor(question);
    assert.ok(offered.includes("add_task"), `${question}: add_task must be offered`);
  }
});

test("a reminder for a moment is handed the schedule, and the to-do list is kept out of its way", async () => {
  for (const question of [
    "remind me to call the bank at 3 pm",
    "remind me at 3 pm to call the bank",
    "Remind me tomorrow at 9:30 am to ring the school",
    "remind me to check the oven in 20 minutes"
  ]) {
    const offered = await offeredFor(question);
    assert.ok(offered.includes("add_schedule"), `${question}: add_schedule must be offered`);
    assert.ok(offered.includes("current_datetime"), `${question}: the clock must be offered, to work the moment out`);
    for (const name of ["add_task", "list_tasks", "complete_task", "remove_task"]) {
      assert.equal(offered.includes(name), false, `${question}: ${name} must not be offered`);
    }
  }
});

test("a repeating reminder is a schedule too, as it was", async () => {
  // Said with its days and its time, this one is saved without a model at all (parseReminderRequest); said looser, it
  // goes to the model, which must have the schedule and not the list.
  const offered = await offeredFor("remind me every weekday to stretch after lunch");
  assert.ok(offered.includes("add_schedule"));
  assert.equal(offered.includes("add_task"), false);
});

test("the to-do list on its own does not bring the schedule with it", async () => {
  const offered = await offeredFor("add buy milk to my to-do list");
  assert.equal(offered.includes("add_schedule"), false);
});
