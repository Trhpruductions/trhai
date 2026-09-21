import test from "node:test";
import assert from "node:assert/strict";
import { runAssistantOrchestrator } from "../src/services/orchestrator.js";
import { parseRemoveScheduleRequest, parseToggleScheduleRequest } from "../src/services/memoryRequests.js";
import { resetPendingConfirmations } from "../src/services/pendingConfirmation.js";

type Schedule = { id: string; name: string; cadenceLabel: string; actionLabel: string; enabled: boolean };

/** A tiny in-memory schedule store, so the seams behave like the real ones. */
function scheduleStore(initial: Schedule[]) {
  const schedules = initial.map((schedule) => ({ ...schedule }));
  return {
    listSchedules: () => schedules.map((schedule) => ({ ...schedule })),
    removeSchedule: (id: string) => {
      const index = schedules.findIndex((schedule) => schedule.id === id);
      if (index === -1) return false;
      schedules.splice(index, 1);
      return true;
    },
    setScheduleEnabled: (id: string, enabled: boolean) => {
      const schedule = schedules.find((entry) => entry.id === id);
      if (!schedule) return false;
      schedule.enabled = enabled;
      return true;
    },
    current: () => schedules
  };
}

const sample = (): Schedule[] => [
  { id: "s1", name: "Check Server Logs", cadenceLabel: "Every day at 9:00 AM", actionLabel: "Asks: check the server logs", enabled: true },
  { id: "s2", name: "Nightly Backup", cadenceLabel: "Every day at 2:00 AM", actionLabel: "Runs: backup.ps1", enabled: true }
];

test("parseRemoveScheduleRequest reads the target, the whole-list case, and rejects non-requests", () => {
  assert.deepEqual(parseRemoveScheduleRequest("cancel my server logs reminder"), { kind: "one", target: "server logs" });
  assert.deepEqual(parseRemoveScheduleRequest("delete the nightly backup schedule"), { kind: "one", target: "nightly backup" });
  assert.deepEqual(parseRemoveScheduleRequest("cancel the reminder to check the server logs"), { kind: "one", target: "check the server logs" });
  // A schedule whose name ends in "Reminder", named exactly, keeps its name.
  assert.deepEqual(parseRemoveScheduleRequest("cancel my Server Logs Reminder schedule"), { kind: "one", target: "server logs reminder" });
  assert.deepEqual(parseRemoveScheduleRequest("stop reminding me to water the plants"), { kind: "one", target: "water the plants" });
  assert.deepEqual(parseRemoveScheduleRequest("cancel all my reminders"), { kind: "all" });
  // Not a schedule-removal request: left to the rest of the pipeline.
  assert.equal(parseRemoveScheduleRequest("cancel my meeting"), null);
  assert.equal(parseRemoveScheduleRequest("what schedules do I have?"), null);
});

test("parseToggleScheduleRequest reads pause and resume, the whole-list case, and rejects non-requests", () => {
  assert.deepEqual(parseToggleScheduleRequest("turn off the 9am reminder"), { kind: "one", target: "9am", enabled: false });
  assert.deepEqual(parseToggleScheduleRequest("pause the nightly backup schedule"), { kind: "one", target: "nightly backup", enabled: false });
  assert.deepEqual(parseToggleScheduleRequest("resume my server logs reminder"), { kind: "one", target: "server logs", enabled: true });
  assert.deepEqual(parseToggleScheduleRequest("turn on all reminders"), { kind: "all", enabled: true });
  // A toggle needs to be about schedules at all.
  assert.equal(parseToggleScheduleRequest("turn off the lights"), null);
});

test("cancelling a schedule offers a confirmation and only removes on yes", async () => {
  resetPendingConfirmations();
  const store = scheduleStore(sample());
  const input = { mode: "general" as const, sessionId: "sched-del", userMessage: "cancel my server logs reminder", ...store };

  const offer = await runAssistantOrchestrator(input);
  assert.equal(offer.strategy, "confirm");
  assert.match(offer.assistantMessage, /would cancel the schedule "Check Server Logs"/);
  assert.equal(store.current().length, 2, "nothing is removed before the user says yes");

  const confirmed = await runAssistantOrchestrator({ ...input, userMessage: "yes" });
  assert.match(confirmed.assistantMessage, /Cancelled the schedule "Check Server Logs"/);
  assert.deepEqual(store.current().map((schedule) => schedule.id), ["s2"], "only the confirmed schedule is removed");
});

test("declining a cancel keeps every schedule", async () => {
  resetPendingConfirmations();
  const store = scheduleStore(sample());
  const input = { mode: "general" as const, sessionId: "sched-del-no", userMessage: "delete the nightly backup schedule", ...store };

  const offer = await runAssistantOrchestrator(input);
  assert.equal(offer.strategy, "confirm");
  const declined = await runAssistantOrchestrator({ ...input, userMessage: "no" });
  assert.match(declined.assistantMessage, /Kept\. Nothing was cancelled\./);
  assert.equal(store.current().length, 2);
});

test("cancelling with a name that matches nothing removes nothing and lists what is there", async () => {
  resetPendingConfirmations();
  const store = scheduleStore(sample());
  const result = await runAssistantOrchestrator({
    mode: "general", sessionId: "sched-del-miss", userMessage: "cancel my grocery reminder", ...store
  });
  assert.match(result.assistantMessage, /No schedule matches "grocery"/);
  assert.match(result.assistantMessage, /Check Server Logs/);
  assert.equal(store.current().length, 2);
});

test("pausing a schedule disables it without a confirmation, and resuming re-enables it", async () => {
  resetPendingConfirmations();
  const store = scheduleStore(sample());

  const paused = await runAssistantOrchestrator({
    mode: "general", sessionId: "sched-toggle", userMessage: "turn off the 9am reminder", ...store
  });
  assert.equal(paused.strategy, "schedule");
  assert.match(paused.assistantMessage, /Paused the schedule "Check Server Logs"/);
  assert.equal(store.current().find((schedule) => schedule.id === "s1")?.enabled, false);

  const resumed = await runAssistantOrchestrator({
    mode: "general", sessionId: "sched-toggle", userMessage: "resume my server logs reminder", ...store
  });
  assert.match(resumed.assistantMessage, /Resumed the schedule "Check Server Logs"/);
  assert.equal(store.current().find((schedule) => schedule.id === "s1")?.enabled, true);
});

test("pausing all schedules disables every one, off the model", async () => {
  resetPendingConfirmations();
  const store = scheduleStore(sample());
  const result = await runAssistantOrchestrator({
    mode: "general", sessionId: "sched-toggle-all", userMessage: "turn off all reminders", ...store
  });
  assert.match(result.assistantMessage, /Paused 2 schedules/);
  assert.equal(store.current().every((schedule) => !schedule.enabled), true);
});

test("an exact name that ends in a schedule noun resolves to that one schedule", async () => {
  resetPendingConfirmations();
  // Two schedules that both contain "server logs"; one is named "... Reminder".
  const store = scheduleStore([
    { id: "s1", name: "Check Server Logs", cadenceLabel: "Every day at 9:00 AM", actionLabel: "Asks: check the server logs", enabled: true },
    { id: "s3", name: "Server Logs Reminder", cadenceLabel: "Every day at 9:00 AM", actionLabel: "Asks: check the server logs", enabled: true }
  ]);
  const offer = await runAssistantOrchestrator({
    mode: "general", sessionId: "sched-exact", userMessage: "cancel my Server Logs Reminder schedule", ...store
  });
  assert.equal(offer.strategy, "confirm", offer.assistantMessage);
  assert.match(offer.assistantMessage, /would cancel the schedule "Server Logs Reminder"/);
});

test("cancelling the only schedule needs no name", async () => {
  resetPendingConfirmations();
  const store = scheduleStore([sample()[0]]);
  const input = { mode: "general" as const, sessionId: "sched-only", userMessage: "cancel my reminder", ...store };

  const offer = await runAssistantOrchestrator(input);
  assert.equal(offer.strategy, "confirm");
  assert.match(offer.assistantMessage, /would cancel the schedule "Check Server Logs"/);
  const confirmed = await runAssistantOrchestrator({ ...input, userMessage: "yes" });
  assert.match(confirmed.assistantMessage, /Cancelled the schedule "Check Server Logs"/);
  assert.equal(store.current().length, 0);
});
