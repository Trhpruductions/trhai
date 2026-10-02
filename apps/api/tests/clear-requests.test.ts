import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Requests that say everything outright - a text with its number and words, a
// schedule with its days and time, a weekday for a date, a summary of a saved
// document - decided without leaving the decision to the model. Each of these
// failed live when it was left to it.

const dataDir = mkdtempSync(path.join(tmpdir(), "trhai-clear-"));
const workspace = mkdtempSync(path.join(tmpdir(), "trhai-clear-ws-"));
process.env.ASCEND_WORKSPACE = workspace;
for (const [name, file] of [["MEMORY", "memory"], ["CONVERSATION", "conversations"], ["ACCOUNTS", "accounts"], ["KNOWLEDGE", "knowledge"], ["TASKS", "tasks"], ["SCHEDULE", "schedules"]]) {
  process.env[`ASSIST_${name}_FILE`] = path.join(dataDir, `${file}.json`);
}
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");
// A dead port: anything here that reached for the model would fail loudly.
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";

const { parseDirectMessage, subjectFrom } = await import("../src/services/messageRequest.js");
const { daysAskedFor, parseReminderRequest, timeAskedFor } = await import("../src/services/scheduleRequest.js");
const { tick } = await import("../src/services/scheduler.js");
const { parseTextToolCalls } = await import("../src/services/agentLoop.js");
const { readingsFor } = await import("../src/services/agentTools.js");
const { answerWeekdayQuestion, parseDate } = await import("../src/services/dateMath.js");
const { runTool } = await import("../src/services/agentTools.js");
const { listSchedules, resetSchedules } = await import("../src/services/scheduleStore.js");
const { runAssistantOrchestrator } = await import("../src/services/orchestrator.js");
const { summarizeDocument } = await import("../src/services/summarize.js");

test.after(() => {
  resetSchedules();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

// ------------------------------------------------------------- texts and emails

test("a text that names the number and the words is read without the model", () => {
  const read = (request: string) => {
    const parsed = parseDirectMessage(request);
    return parsed?.tool === "send_text" ? parsed.arguments : parsed;
  };
  assert.deepEqual(read("text 555-010-0123 that I'm running 10 minutes late"), { to: "555-010-0123", message: "I'm running 10 minutes late" });
  assert.deepEqual(read("can you text 555-010-0123 that I'm running late?"), { to: "555-010-0123", message: "I'm running late" },
    "the question mark is the request's");
  assert.deepEqual(read("send a text to +1 555 010 0123 saying \"On my way!\""), { to: "+1 555 010 0123", message: "On my way!" });
  assert.deepEqual(read("text 5550100123: running late"), { to: "5550100123", message: "Running late" });
  assert.deepEqual(read("please text 555-0123 and tell them I'll be there at 6"), { to: "555-0123", message: "I'll be there at 6" });
  assert.deepEqual(read("send 555-010-0123 a text saying hi there"), { to: "555-010-0123", message: "Hi there" });
  assert.deepEqual(read("text (555) 010-0123 to say the door code is 4412"), { to: "(555) 010-0123", message: "The door code is 4412" });
});

test("an email that names the address and the words gets a subject from its first sentence", () => {
  assert.deepEqual(parseDirectMessage("email bob@example.com that the meeting moved to 3pm. Bring the slides."), {
    tool: "send_email",
    arguments: { to: "bob@example.com", subject: "The meeting moved to 3pm", body: "The meeting moved to 3pm. Bring the slides." }
  });
  assert.equal(subjectFrom("The quarterly numbers are in and they look much better than anyone on the team expected"),
    "The quarterly numbers are in and they look much better than...");
});

test("a request that leaves anything to decide still goes to the model", () => {
  for (const request of [
    "text mom that I'm running late",            // a name, not a number
    "text 555-010-0123 about dinner tonight",    // asks for a message to be written
    "text 555-010-0123 that's fine",             // "that's" is the message, not a joiner
    "text 555-010-0123 10 minutes late",         // nothing marks where the words start
    "what's the best way to text 555-010-0123",  // not a request to send
    "email my boss that I'm sick today",         // no address
    "text 12 that hi"                            // not a phone number
  ]) {
    assert.equal(parseDirectMessage(request), null, request);
  }
});

const messaging = () => {
  const opened: string[] = [];
  return {
    opened,
    deps: { phoneLink: "linked" as const, open: async (url: string) => { opened.push(url); return true; }, copy: async () => true }
  };
};

test("a clear text is held word for word with no model, and only a yes sends it", async () => {
  const phone = messaging();
  const held = await runAssistantOrchestrator({
    mode: "general", sessionId: "clear-text-1", userMessage: "text 555-010-0123 that I'm running 10 minutes late", messaging: phone.deps
  });
  assert.match(held.assistantMessage, /Here's the text for \(555\) 010-0123:\n\n> I'm running 10 minutes late/);
  assert.equal(held.pendingConfirmation?.tool, "send_text");
  assert.deepEqual(phone.opened, [], "nothing goes before the yes");

  const declined = await runAssistantOrchestrator({ mode: "general", sessionId: "clear-text-1", userMessage: "no", messaging: phone.deps });
  assert.match(declined.assistantMessage, /Not sent/);
  assert.deepEqual(phone.opened, []);

  await runAssistantOrchestrator({ mode: "general", sessionId: "clear-text-2", userMessage: "text 555-010-0123 that I'm on my way", messaging: phone.deps });
  const sent = await runAssistantOrchestrator({ mode: "general", sessionId: "clear-text-2", userMessage: "yes", messaging: phone.deps });
  assert.deepEqual(phone.opened, ["sms:5550100123?body=I'm%20on%20my%20way"]);
  assert.match(sent.assistantMessage, /went to Phone Link/);
});

test("with no phone linked, a clear text says so instead of holding one that cannot go", async () => {
  const unlinked = await runAssistantOrchestrator({
    mode: "general", sessionId: "clear-text-3", userMessage: "text 555-010-0123 that I'm running late",
    messaging: { phoneLink: "not-linked", open: async () => true, copy: async () => true }
  });
  assert.match(unlinked.assistantMessage, /no phone is linked/);
  assert.equal(unlinked.pendingConfirmation, undefined);
});

// ------------------------------------------------------------- schedules

test("which days and what time a schedule asks for are read from the request", () => {
  assert.equal(daysAskedFor("every day at 9:15 am remind me to drink water"), "every day");
  assert.equal(daysAskedFor("remind me everyday to stretch"), "every day");
  assert.equal(daysAskedFor("every weekday at 8am ask me if the build passed"), "weekdays");
  assert.equal(daysAskedFor("every weekday morning check the news"), "weekdays");
  assert.equal(daysAskedFor("remind me daily except weekends at 7:30 pm"), "weekdays");
  assert.equal(daysAskedFor("every day at 9, and on weekdays at 5"), null, "both: the model sorts it out");
  assert.equal(daysAskedFor("every 30 minutes remind me to stand up"), null);

  assert.equal(timeAskedFor("every day at 9:15 am remind me to drink water"), 9 * 60 + 15);
  assert.equal(timeAskedFor("every weekday at 8am"), 8 * 60);
  assert.equal(timeAskedFor("at 7:30 p.m. every day"), 19 * 60 + 30);
  assert.equal(timeAskedFor("at 12 am"), 0);
  assert.equal(timeAskedFor("at 12 pm"), 12 * 60);
  assert.equal(timeAskedFor("every day at 21:00"), 21 * 60);
  assert.equal(timeAskedFor("every day at noon"), 12 * 60);
  assert.equal(timeAskedFor("at 9 am and 5 pm"), null, "two times are two schedules");
  assert.equal(timeAskedFor("every 30 minutes"), null);
});

test("add_schedule keeps the days and the time the user said, whatever the model passed", async () => {
  resetSchedules();
  const saved = await runTool(
    { name: "add_schedule", arguments: { name: "Drink water", prompt: "Time to drink water", daily_at: "09:00", weekdays_only: true } },
    { memories: [], knowledge: [], request: "every day at 9:15 am remind me to drink water" }
  );
  assert.equal(saved.ok, true);
  assert.match(saved.content, /Every day at 9:15/);
  assert.deepEqual(listSchedules()[0].cadence, { kind: "daily", minuteOfDay: 9 * 60 + 15 });

  const weekdays = await runTool(
    { name: "add_schedule", arguments: { name: "Build check", prompt: "Did the build pass?", daily_at: "08:00" } },
    { memories: [], knowledge: [], request: "every weekday at 8am ask me if the build passed" }
  );
  assert.match(weekdays.content, /Every weekday at 8:00/);

  const unsaid = await runTool(
    { name: "add_schedule", arguments: { name: "Standup", prompt: "Standup notes?", daily_at: "10:00", weekdays_only: true } },
    { memories: [], knowledge: [], request: "set up my standup reminder" }
  );
  assert.match(unsaid.content, /Every weekday at 10:00/, "nothing said about days: the model's reading stands");
  resetSchedules();
});

test("a reminder with its words and its timing all there is read without the model", () => {
  const water = { text: "Drink water", cadence: { kind: "daily", minuteOfDay: 9 * 60 + 15 } };
  assert.deepEqual(parseReminderRequest("every day at 9:15 am remind me to drink water"), water);
  assert.deepEqual(parseReminderRequest("remind me to drink water every day at 9:15 am"), water);
  assert.deepEqual(parseReminderRequest("remind me every 30 minutes to stretch"), { text: "Stretch", cadence: { kind: "interval", minutes: 30 } });
  assert.deepEqual(parseReminderRequest("remind me every 2 hours to look away from the screen"),
    { text: "Look away from the screen", cadence: { kind: "interval", minutes: 120 } });
  assert.deepEqual(parseReminderRequest("remind me every weekday at 8:30am that standup is at 9"),
    { text: "Standup is at 9", cadence: { kind: "daily", minuteOfDay: 8 * 60 + 30, weekdaysOnly: true } }, "the words keep their own \"at 9\"");
  for (const notOne of [
    "remind me at 9 am to call mom",        // once - schedules here repeat
    "remind me tomorrow to call mom",
    "remind me to stretch",                 // no timing at all
    "every day at 9 remind me to stretch",  // "9" with no am/pm is not a clock time
    "every day at 9 am ask me if the build passed",
    "what reminders do I have?"
  ]) {
    assert.equal(parseReminderRequest(notOne), null, notOne);
  }
});

test("a clear reminder is saved as one, never twice, and fires as its own words with no model", async () => {
  resetSchedules();
  const saved = await runAssistantOrchestrator({ mode: "general", sessionId: "clear-remind", userMessage: "every day at 9:15 am remind me to drink water" });
  assert.match(saved.assistantMessage, /Scheduled "Drink water": Every day at 9:15/);
  assert.equal(saved.strategy, "schedule");
  const [schedule] = listSchedules();
  assert.deepEqual(schedule.action, { kind: "remind", text: "Drink water" });

  const again = await runAssistantOrchestrator({ mode: "general", sessionId: "clear-remind", userMessage: "remind me to drink water every day at 9:15 am" });
  assert.match(again.assistantMessage, /Already scheduled/);
  assert.equal(listSchedules().length, 1);

  await tick(new Date(Date.parse(schedule.nextDueAt) + 1000));
  await new Promise((resolve) => setImmediate(resolve));
  const fired = listSchedules()[0];
  assert.equal(fired.lastStatus, "ok");
  assert.equal(fired.lastDetail, "Drink water", "the reminder's own words, no model reply");
  resetSchedules();
});

test("a tool call written as its arguments alone is read as that tool's call, and only then", () => {
  // The reply seen live, after which nothing had been saved.
  const leaked = 'Saved the schedule: {"name": "drink-water-reminder", "prompt": "Drink water", "daily_at": "09:15", "every_minutes": null, "weekdays_only": false}';
  const calls = parseTextToolCalls(leaked);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "add_schedule");
  assert.equal(calls[0].arguments.daily_at, "09:15");

  const example = "Here is an example of a schedule configuration you could use in your own app, with a name, "
    + 'a prompt and a time: {"name": "standup", "prompt": "Notes?", "daily_at": "09:00"} - adapt it to your needs and save it as config.json.';
  assert.deepEqual(parseTextToolCalls(example), [], "an example inside a real answer is not a call");
  assert.deepEqual(parseTextToolCalls('{"title": "Groceries", "color": "blue"}'), [], "keys that are no tool's");
});

// ------------------------------------------------------------- machine readings

const readings = async () => ({
  cpu: { model: "Test CPU", cores: 16, speedMhz: 4200, fraction: 0.27, detail: "27% across 16 cores", unavailable: null },
  memory: { fraction: 0.57, detail: "18.2 / 31.9 GB", unavailable: null },
  gpu: {
    name: "NVIDIA GeForce RTX 4060 Ti", fraction: 0.12, detail: "12% busy", unavailable: null,
    vram: { fraction: 0.74, detail: "5.9 / 8.0 GB", unavailable: null },
    temperatureC: 48, clockMhz: 2535, powerWatts: null
  },
  cloud: { services: [], detail: "" },
  disk: { fraction: 0.5, detail: "1.82 / 3.64 TB", unavailable: null },
  network: { fraction: null, detail: "", unavailable: "Measuring…", receivedBytesPerSecond: null, sentBytesPerSecond: null },
  uptimeSeconds: 3 * 86400 + 4 * 3600 + 120,
  takenAt: new Date(0).toISOString()
});

test("a question about one reading gets that reading's line", () => {
  const all = [
    "Processor: 27% busy across 16 cores (Test CPU).",
    "Memory: 18.2 / 31.9 GB in use (57%).",
    "Programs using the most memory: chrome 4.3 GB.",
    "Graphics card: NVIDIA GeForce RTX 4060 Ti, 12% busy, 48°C.",
    "Drive D: 1.6 TB free of 3.6 TB (56% used).",
    "Up for: 3 days, 4 hours."
  ].join("\n");
  assert.equal(readingsFor("how much RAM am I using?", all), "Memory: 18.2 / 31.9 GB in use (57%).\nPrograms using the most memory: chrome 4.3 GB.");
  assert.equal(readingsFor("how much space is left on drive D?", all), "Drive D: 1.6 TB free of 3.6 TB (56% used).");
  assert.equal(readingsFor("how's my PC doing?", all), all, "nothing in particular: everything");
  assert.match(readingsFor("how hot is my CPU?", all), /^Processor:.*\nGraphics card:.*\nProcessor temperature: not measured here/s);
});

test("a reading question is answered from the readings, not by the model", async () => {
  const answered = await runAssistantOrchestrator({
    mode: "general", sessionId: "clear-reading", userMessage: "how much memory is my computer using right now?", readTelemetry: readings
  });
  assert.equal(answered.strategy, "reading");
  assert.match(answered.assistantMessage, /^Memory: 18\.2 \/ 31\.9 GB in use \(57%\)\.$/m);

  const advice = await runAssistantOrchestrator({
    mode: "general", sessionId: "clear-reading-2", userMessage: "why is my computer using so much memory?", readTelemetry: readings
  });
  assert.notEqual(advice.strategy, "reading", "advice about a reading is still the model's");
});

// ------------------------------------------------------------- weekdays

const today = new Date(2026, 9, 2); // Friday, October 2, 2026

test("the weekday of a date is worked out from the calendar, not guessed", () => {
  assert.match(answerWeekdayQuestion("what day of the week is December 25, 2026?", today) ?? "", /is a Friday\.$/);
  assert.match(answerWeekdayQuestion("What day was July 4, 1776?", today) ?? "", /was a Thursday\.$/);
  assert.match(answerWeekdayQuestion("what day of the week will January 1, 2030 be?", today) ?? "", /is a Tuesday\.$/);
  assert.match(answerWeekdayQuestion("what's the day of the week for 12/25/2026", today) ?? "", /is a Friday\.$/);
  assert.match(answerWeekdayQuestion("which day is the 4th of July", today) ?? "", /was a Saturday\.$/, "no year: this year's");
  assert.match(answerWeekdayQuestion("what day is today?", today) ?? "", /is a Friday\.$/);
  for (const notOne of ["what day is it", "how many days until Christmas?", "what day of the week is my birthday?", "what's the weather"]) {
    assert.equal(answerWeekdayQuestion(notOne, today), null, notOne);
  }
  assert.equal(parseDate("2/30/2026", today), null, "no 30th of February");
});

test("a weekday question is answered without the model", async () => {
  const answered = await runAssistantOrchestrator({
    mode: "general", sessionId: "clear-weekday", userMessage: "what day of the week is December 25, 2026?"
  });
  assert.match(answered.assistantMessage, /is a Friday\./);
  assert.equal(answered.strategy, "calendar");
});

// ------------------------------------------------------------- summaries

/** A stand-in model that records each prompt and answers by kind. */
function recordingModel() {
  const prompts: string[] = [];
  return {
    prompts,
    generate: async (prompt: string) => {
      prompts.push(prompt);
      if (/You are taking notes on part (\d+)/.test(prompt)) {
        const part = /part (\d+) of/.exec(prompt)?.[1];
        return { ok: true as const, text: `- Notes on part ${part}: ${/Key fact: ([^.]+)/.exec(prompt)?.[1] ?? "nothing"}` };
      }
      return { ok: true as const, text: "Harbor Town Handbook: a guide to the town.", model: "qwen2.5-coder:7b" };
    }
  };
}

const longHandbook = ["the lighthouse was built in 1891", "the ferry runs every 40 minutes", "the bakery closes on Tuesdays"]
  .map((fact, index) => `Section ${index + 1}. Key fact: ${fact}. ${"Routine notes about weather, visitors and upkeep. ".repeat(260)}`)
  .join("\n\n");

test("a long document is read in every part before the summary is written", async () => {
  const model = recordingModel();
  const written = await summarizeDocument("Harbor Town Handbook", longHandbook, { generate: model.generate });
  assert.equal(written.ok, true);
  const notesPrompts = model.prompts.filter((prompt) => prompt.startsWith("You are taking notes"));
  assert.ok(notesPrompts.length >= 3, `every part read (${notesPrompts.length} prompts)`);
  const last = model.prompts.at(-1) ?? "";
  assert.match(last, /notes taken on every part/);
  for (const fact of ["1891", "40 minutes", "Tuesdays"]) assert.ok(last.includes(fact), `the write-up sees ${fact}`);

  const short = recordingModel();
  await summarizeDocument("Memo", "The office closes at 5pm on Fridays.", { generate: short.generate });
  assert.equal(short.prompts.length, 1, "a short one is written from the whole text at once");
  assert.match(short.prompts[0], /This is the whole of the document "Memo"/);
});

test("summarize a saved document by name: read in full here, not left to the model", async () => {
  const model = recordingModel();
  const answered = await runAssistantOrchestrator({
    mode: "general", sessionId: "clear-summary", userMessage: "summarize the Harbor Town Handbook document",
    documents: [{ id: "doc-1", title: "Harbor Town Handbook", body: longHandbook }, { id: "doc-2", title: "Recipes", body: "Bread." }],
    generateText: model.generate
  });
  assert.equal(answered.assistantMessage, "Harbor Town Handbook: a guide to the town.");
  assert.equal(answered.model, "ollama/qwen2.5-coder:7b");
  assert.ok(model.prompts.some((prompt) => prompt.includes("Key fact: the bakery closes")), "the last section was read");

  const unnamed = recordingModel();
  const other = await runAssistantOrchestrator({
    mode: "general", sessionId: "clear-summary-2", userMessage: "summarize the news for me",
    documents: [{ id: "doc-1", title: "Harbor Town Handbook", body: longHandbook }], generateText: unnamed.generate
  });
  assert.equal(unnamed.prompts.length, 0, "no saved document named: not this route");
  assert.ok(other.assistantMessage.length > 0);
});
