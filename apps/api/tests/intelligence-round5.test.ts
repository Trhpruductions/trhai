import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRequest } from "../src/services/requestAnalysis.js";
import { composeReply } from "../src/services/replyComposer.js";
import { extractMemoryCandidates } from "../src/services/memoryExtraction.js";
import { availableTools, runTool, type ToolContext } from "../src/services/agentTools.js";
import { mentionsTime, mentionsWeb } from "../src/services/actionIntent.js";
import { resetSchedules, setSchedulePersistence } from "../src/services/scheduleStore.js";
import { isListSchedulesRequest } from "../src/services/memoryRequests.js";
import { runAssistantOrchestrator } from "../src/services/orchestrator.js";

// Fifth intelligence sweep. Every case was found by asking the running
// assistant and reading the reply; the phrasings are the real ones.

// ---------------------------------------------------------------------------
// A request is a request whatever it opens with.

test("requests that were read as statements", () => {
  for (const message of [
    // "Got it." - the file untouched.
    "now add a line saying omega to the end of it",
    // "Got it." - no schedule made.
    "every weekday at 8am ask me whether the build passed",
    // "Got it."
    "convert 5 miles to kilometers",
    "send an email to bob@example.com saying hi",
    "then read it back to me",
    "edit notes.txt so the second line says delta"
  ]) {
    assert.equal(analyzeRequest(message).shape, "command", message);
  }
  assert.equal(analyzeRequest("now add a line saying omega to the end of it").action, "add");
  // Still statements: the connective is followed by no verb.
  assert.equal(analyzeRequest("now the server is on port 4000").shape, "statement");
});

// ---------------------------------------------------------------------------
// Things the app cannot do are said plainly, not improvised.

test("email, messages, calls and purchases are declined at once", () => {
  const cases: Array<[string, RegExp]> = [
    ["send an email to bob@example.com saying hi", /can't send email/],
    ["email bob@example.com the report", /can't send email/],
    ["text bob that I'm running late", /can't send messages/],
    ["send a message to alice saying the build passed", /can't send messages/],
    ["call bob", /can't make calls/],
    ["buy me a coffee", /can't buy/],
    ["book a table for two tonight", /can't buy or book/]
  ];
  for (const [message, expected] of cases) {
    const reply = composeReply({ mode: "general", message, memories: [], history: [] });
    assert.equal(reply.strategy, "cannot", message);
    assert.match(reply.text, expected, message);
  }
  for (const message of ["call me Hank", "order the list by date", "book club is on thursdays", "text here is fine"]) {
    assert.notEqual(composeReply({ mode: "general", message, memories: [], history: [] }).strategy, "cannot", message);
  }
});

test("a message with no words in it is asked about", () => {
  // "???" reached the model, which answered with the date and time.
  const reply = composeReply({ mode: "general", message: "???", memories: [], history: [] });
  assert.equal(reply.strategy, "clarify");
  assert.match(reply.text, /didn't catch that/);
});

// ---------------------------------------------------------------------------
// The user introducing themselves is worth keeping.

test("a profile fact is remembered without the word remember", () => {
  assert.equal(extractMemoryCandidates("my name is Hank")[0]?.body, "my name is Hank");
  assert.equal(extractMemoryCandidates("My email is hank@example.com")[0]?.body, "My email is hank@example.com");
  assert.equal(extractMemoryCandidates("call me Hank")[0]?.body, "call me Hank");
  assert.deepEqual(extractMemoryCandidates("my day was long"), []);
  assert.deepEqual(extractMemoryCandidates("my api port is 8080"), [], "said in passing, not a profile fact");
});

// ---------------------------------------------------------------------------
// update_document cannot lose what is there by accident.

function documentContext() {
  const updates: Array<[string, string]> = [];
  const context: ToolContext = {
    memories: [],
    knowledge: [],
    documents: [{ id: "d1", title: "Deploy Steps", body: "run the migration, then restart the api" }],
    updateDocument: (id: string, body: string) => {
      updates.push([id, body]);
      return true;
    }
  };
  return { context, updates };
}

test("appending keeps the document's text", async () => {
  // Verbatim. Asked to add "then clear the cache" to the end, the model sent
  // a body it made up and the user's steps were gone.
  const { context, updates } = documentContext();
  const result = await runTool(
    { name: "update_document", arguments: { title: "Deploy Steps", append: "then clear the cache" } },
    context
  );
  assert.equal(result.ok, true, result.content);
  assert.deepEqual(updates, [["d1", "run the migration, then restart the api\nthen clear the cache"]]);
});

test("a passage is changed in place", async () => {
  const { context, updates } = documentContext();
  const result = await runTool(
    { name: "update_document", arguments: { title: "Deploy Steps", old_text: "restart the api", new_text: "restart the api and the worker" } },
    context
  );
  assert.equal(result.ok, true, result.content);
  assert.deepEqual(updates, [["d1", "run the migration, then restart the api and the worker"]]);

  const missing = await runTool(
    { name: "update_document", arguments: { title: "Deploy Steps", old_text: "reboot", new_text: "x" } },
    context
  );
  assert.equal(missing.ok, false);
  assert.match(missing.content, /does not contain/);
  assert.match(missing.content, /run the migration/, "the current text is handed back");
});

test("a whole replacement has to be asked for by name", async () => {
  const { context, updates } = documentContext();
  const refused = await runTool(
    { name: "update_document", arguments: { title: "Deploy Steps", content: "1. Build 2. Test 3. Deploy" } },
    context
  );
  assert.equal(refused.ok, false);
  assert.deepEqual(updates, [], "nothing is replaced");
  assert.match(refused.content, /would replace the whole/);
  assert.match(refused.content, /run the migration, then restart the api/);
  assert.match(refused.content, /append/);

  const replaced = await runTool(
    { name: "update_document", arguments: { title: "Deploy Steps", content: "1. Build 2. Test 3. Deploy", replace_everything: true } },
    context
  );
  assert.equal(replaced.ok, true, replaced.content);
  assert.deepEqual(updates, [["d1", "1. Build 2. Test 3. Deploy"]]);

  const nothing = await runTool({ name: "update_document", arguments: { title: "Deploy Steps" } }, context);
  assert.equal(nothing.ok, false);
  assert.match(nothing.content, /append, or old_text/);
});

// ---------------------------------------------------------------------------
// Schedules are listed from the store.

test("the ways a person asks what is scheduled", () => {
  for (const message of ["what schedules do I have?", "list my schedules", "show me my reminders", "do I have any schedules?"]) {
    assert.equal(isListSchedulesRequest(message), true, message);
  }
  assert.equal(isListSchedulesRequest("schedule a build check every day"), false);
});

test("schedules are listed without a model", async () => {
  // Verbatim. Answered from the transcript with the request that made the
  // schedule, quoted back as if it were the answer.
  const ask = (userMessage: string, schedules: Array<{ id: string; name: string; cadenceLabel: string; actionLabel: string; enabled: boolean }>) =>
    runAssistantOrchestrator({ mode: "general", userMessage, sessionId: "schedules-flow", listSchedules: () => schedules });

  const listed = await ask("what schedules do I have?", [
    { id: "s1", name: "Build Check", cadenceLabel: "Every weekday at 8:00 AM", actionLabel: "Asks: whether the build passed", enabled: true },
    { id: "s2", name: "Backup", cadenceLabel: "Every day at 2:00 AM", actionLabel: "Runs: backup.ps1", enabled: false }
  ]);
  assert.equal(listed.strategy, "list", listed.assistantMessage);
  assert.match(listed.assistantMessage, /Build Check: Every weekday at 8:00 AM/);
  assert.match(listed.assistantMessage, /Backup: .*\(paused\)/);

  const none = await ask("list my schedules", []);
  assert.match(none.assistantMessage, /No schedules are set/);
});

// ---------------------------------------------------------------------------
// A title that exists is changed, never doubled.

test("write_document refuses a title that already exists", async () => {
  // A session ended up with two "Deploy Steps" documents and every read
  // quoted both.
  const saved: string[] = [];
  const result = await runTool(
    { name: "write_document", arguments: { title: "deploy steps", content: "new text" } },
    {
      memories: [],
      knowledge: [],
      documents: [{ id: "d1", title: "Deploy Steps", body: "run the migration" }],
      saveDocument: (title: string) => { saved.push(title); return true; }
    }
  );
  assert.equal(result.ok, false);
  assert.deepEqual(saved, []);
  assert.match(result.content, /already exists/);
  assert.match(result.content, /update_document/);
});

// ---------------------------------------------------------------------------
// The same schedule is not made twice.

test("add_schedule reports a duplicate as already done", async () => {
  // Asked for one daily check, the model called add_schedule four times
  // across four rounds and four schedules were saved. Refused as a
  // duplicate, it then reworded the prompt until one got past the check -
  // so an existing identical schedule is reported as the request already
  // satisfied.
  setSchedulePersistence(false);
  resetSchedules();
  const context: ToolContext = { memories: [], knowledge: [] };
  const first = await runTool(
    { name: "add_schedule", arguments: { name: "Build Check", prompt: "Did the build pass?", daily_at: "08:00" } },
    context
  );
  assert.equal(first.ok, true, first.content);

  const sameName = await runTool(
    { name: "add_schedule", arguments: { name: "Build Check", prompt: "What is the build status?", daily_at: "08:00" } },
    context
  );
  assert.equal(sameName.ok, true, "the schedule asked for exists");
  assert.match(sameName.content, /Already scheduled/);
  assert.match(sameName.content, /Nothing new was added/);

  const samePrompt = await runTool(
    { name: "add_schedule", arguments: { name: "Morning check", prompt: "did the build pass?", daily_at: "08:00" } },
    context
  );
  assert.equal(samePrompt.ok, true);
  const { listSchedules } = await import("../src/services/scheduleStore.js");
  assert.equal(listSchedules().length, 1, "one schedule, whatever the wording of the repeats");

  // A different time is a different schedule.
  const evening = await runTool(
    { name: "add_schedule", arguments: { name: "Build Check", prompt: "Did the build pass?", daily_at: "18:00" } },
    context
  );
  assert.equal(evening.ok, true, evening.content);
  resetSchedules();
});

// ---------------------------------------------------------------------------
// The web and the clock are only in reach when the request is about them.

test("fetch_url refuses a file path and points at read_file", async () => {
  // "read C:/.../notes.txt" became fetch_url on the path, refused as "not
  // http", and the file was never read.
  const result = await runTool(
    { name: "fetch_url", arguments: { url: "C:/Users/hank/notes.txt" } },
    { memories: [], knowledge: [] }
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /file path/);
  assert.match(result.content, /read_file/);
});

test("fetch_url and current_datetime are offered only when the request calls for them", () => {
  assert.equal(mentionsWeb("read C:/Users/hank/notes.txt"), false);
  assert.equal(mentionsWeb("fetch https://example.com and tell me what it says"), true);
  assert.equal(mentionsWeb("what does example.com say"), true);
  assert.equal(mentionsTime("what port does DayZ use by default?"), false);
  assert.equal(mentionsTime("what day is it today?"), true);
  assert.equal(mentionsTime("remind me tomorrow"), true);

  const names = (options: Parameters<typeof availableTools>[1]) =>
    availableTools(true, options).map((definition) => definition.function.name);
  assert.ok(!names({ web: false }).includes("fetch_url"));
  assert.ok(!names({ time: false }).includes("current_datetime"));
  assert.ok(names({}).includes("fetch_url"));
  assert.ok(names({}).includes("current_datetime"));
  // A write that names an action is not a build.
  assert.ok(!names({ scaffolding: false }).includes("build_app"));
});

// ---------------------------------------------------------------------------
// "it" is the file the previous turn touched.

test("a pronoun after a file verb is resolved to the last file touched", async () => {
  const { noteFileTouched, resetTouchedFiles, resolveFilePronoun } = await import("../src/services/activeProject.js");
  resetTouchedFiles();
  const session = "pronoun-session";

  // Nothing touched yet: nothing to resolve.
  assert.equal(resolveFilePronoun("now add a line saying omega to the end of it", session), null);

  noteFileTouched(session, "C:/tmp/notes.txt");
  const resolved = resolveFilePronoun("now add a line saying omega to the end of it", session);
  assert.ok(resolved, "resolved");
  assert.equal(resolved.file, "C:/tmp/notes.txt");
  assert.match(resolved.request, /notes\.txt/);
  assert.equal(analyzeRequest(resolved.request).shape, "command");

  // A request that names its own file is left alone; so is one with no
  // file pronoun.
  assert.equal(resolveFilePronoun("add a line to other.txt", session), null);
  assert.equal(resolveFilePronoun("what is 2 + 2", session), null);
  assert.equal(resolveFilePronoun("is it raining", session), null);
  resetTouchedFiles();
});

test("with the pronoun resolved the request is a write, so nothing is scaffolded", async () => {
  const { classifyIntent } = await import("../src/services/actionIntent.js");
  const { noteFileTouched, resetTouchedFiles, resolveFilePronoun } = await import("../src/services/activeProject.js");
  resetTouchedFiles();
  noteFileTouched("pronoun-write", "notes.txt");
  const resolved = resolveFilePronoun("now add a line saying omega to the end of it", "pronoun-write");
  assert.ok(resolved);
  const intent = classifyIntent(resolved.request);
  assert.equal(intent.kind, "write");
  assert.equal(intent.hasTarget, true);
  resetTouchedFiles();
});

// ---------------------------------------------------------------------------
// Appending to a file is its own operation.

test("edit_file appends without a passage to replace", async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { armCommands, disarmCommands } = await import("../src/services/commandRunner.js");
  const dir = mkdtempSync(path.join(tmpdir(), "ascend-append-"));
  const file = path.join(dir, "notes.txt");
  writeFileSync(file, "alpha\nbeta", "utf8");

  armCommands();
  try {
    // Verbatim: "add a line saying omega to the end of it" was tried as a
    // replacement three times and failed each time.
    const result = await runTool({ name: "edit_file", arguments: { path: file, append: "omega" } }, { memories: [], knowledge: [] });
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /Added 1 line to the end of/);
    assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\nomega\n");

    const two = await runTool({ name: "edit_file", arguments: { path: file, append: "\ngamma\ndelta\n" } }, { memories: [], knowledge: [] });
    assert.equal(two.ok, true, two.content);
    // The leading newline the model added "to be safe" is not a blank line.
    assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\nomega\ngamma\ndelta\n");

    const nothing = await runTool({ name: "edit_file", arguments: { path: file } }, { memories: [], knowledge: [] });
    assert.equal(nothing.ok, false);
    assert.match(nothing.content, /append or old_text/);
  } finally {
    disarmCommands();
  }
});

test("'it has been added as the last two lines' is a claim of a change", async () => {
  const { claimsUnperformedMutation } = await import("../src/services/contradictedClaims.js");
  // Seen live after three failed edit_file calls, and returned to the user.
  assert.equal(claimsUnperformedMutation('The text "omega" was not found in the file. It has been added as the last two lines.', false), true);
  assert.equal(claimsUnperformedMutation("Two and two have been added together.", false), false, "arithmetic is not a file change");
  assert.equal(claimsUnperformedMutation("It has been added as the last two lines.", true), false, "a real change is not a lie");
});

test("a file tool call naming the implied file by its name is corrected to it", async () => {
  const { impliedFileFor } = await import("../src/services/activeProject.js");
  // Verbatim: handed C:/.../iq4/notes.txt, the model read D:\Vexora\notes.txt
  // and then D:\Vexora\workspace\notes.txt.
  const implied = "C:/Users/hank/AppData/Local/Temp/iq4/notes.txt";
  assert.equal(impliedFileFor(implied, "D:\\Vexora\\notes.txt"), implied);
  assert.equal(impliedFileFor(implied, "notes.txt"), implied);
  assert.equal(impliedFileFor(implied, "NOTES.TXT"), implied);
  assert.equal(impliedFileFor(implied, "other.txt"), "other.txt", "a different name is a different file");
  assert.equal(impliedFileFor(undefined, "notes.txt"), "notes.txt");
});

test("write_document refuses to make a document of the file the turn is about", async () => {
  const saved: string[] = [];
  const result = await runTool(
    { name: "write_document", arguments: { title: "notes.txt", content: "alpha\nbeta\nomega" } },
    { memories: [], knowledge: [], documents: [], impliedFile: "C:/tmp/notes.txt", saveDocument: (title: string) => { saved.push(title); return true; } }
  );
  assert.equal(result.ok, false);
  assert.deepEqual(saved, []);
  assert.match(result.content, /is the file C:\/tmp\/notes\.txt/);
  assert.match(result.content, /edit_file/);
});

test("an order the model could not carry out is reported, not planned", async () => {
  // Verbatim: "1. Write down what done looks like for now add a line saying
  // omega to the end of it" - the composer's plan template, returned for a
  // request to append one line, after the model loop failed.
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:1";
  try {
    const reply = await runAssistantOrchestrator({ mode: "general", userMessage: "add a line saying omega to the end of notes.txt", sessionId: "order-failed" });
    assert.notEqual(reply.strategy, "plan", reply.assistantMessage);
    assert.doesNotMatch(reply.assistantMessage, /Write down what done looks like/);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
  }
});

test("'nothing was changed' is a denial, not a claim", async () => {
  const { claimsUnperformedMutation } = await import("../src/services/contradictedClaims.js");
  // Seen live: "There is no file at that path, so nothing was changed" was
  // read as a claim of a change and replaced with a generic denial.
  assert.equal(claimsUnperformedMutation("There is no file at that path, so nothing was changed.", false), false);
  assert.equal(claimsUnperformedMutation("Nothing has been written yet.", false), false);
  assert.equal(claimsUnperformedMutation("The file was changed.", false), true);
  assert.equal(claimsUnperformedMutation("The file has been updated.", false), true);
});

test("a resolved pronoun request is never handed the build_app instruction", async () => {
  // The composer's create plan appended "Call build_app with this ... Do not
  // stop at explaining what it would contain", and "contain" made the loop's
  // classifier read the request as asking for a file's contents - so the
  // tools that write were withheld from a request to write.
  const { classifyIntent } = await import("../src/services/actionIntent.js");
  const { noteFileTouched, resetTouchedFiles, resolveFilePronoun } = await import("../src/services/activeProject.js");
  resetTouchedFiles();
  noteFileTouched("pronoun-plan", "C:/tmp/notes.txt");
  const resolved = resolveFilePronoun("now add a line saying omega to the end of it", "pronoun-plan");
  assert.ok(resolved);
  assert.doesNotMatch(resolved.request, /build_app/);
  const intent = classifyIntent(resolved.request);
  assert.equal(intent.kind, "write", JSON.stringify(intent));
  // And the wording of the note itself does not read as a read.
  assert.equal(classifyIntent(`${resolved.request}`).reason.includes("contents"), false);
  resetTouchedFiles();
});

test("a reply wrapped in an invented tool call is unwrapped", async () => {
  const { unwrapPseudoReply } = await import("../src/services/agentLoop.js");
  // Verbatim, as the whole user-facing reply.
  const wrapped = '{\n  "name": "send_message",\n  "arguments": {\n    "text": "I\'ve already created a schedule this turn."\n  }\n}';
  assert.equal(unwrapPseudoReply(wrapped), "I've already created a schedule this turn.");
  assert.equal(unwrapPseudoReply('{"name": "respond", "parameters": {"message": "Done."}}'), "Done.");
  assert.equal(unwrapPseudoReply("```json\n{\"name\": \"reply\", \"arguments\": {\"content\": \"Hello.\"}}\n```"), "Hello.");
  // Prose, and JSON that is not a pseudo call, are left alone.
  assert.equal(unwrapPseudoReply("The build passed."), "The build passed.");
  assert.equal(unwrapPseudoReply('{"port": 4000}'), '{"port": 4000}');
  assert.equal(unwrapPseudoReply('{"name": "x", "arguments": {"count": 3}}'), '{"name": "x", "arguments": {"count": 3}}');
});

test("a weekday schedule skips the weekend", async () => {
  const { describeCadence, isCadence, nextDueAfter } = await import("../src/services/scheduleStore.js");
  const cadence = { kind: "daily" as const, minuteOfDay: 8 * 60, weekdaysOnly: true };
  assert.equal(isCadence(cadence), true);
  assert.equal(describeCadence(cadence), "Every weekday at 8:00 AM");
  // 2026-09-18 is a Friday. After 8am Friday, the next run is Monday.
  const friday = new Date(2026, 8, 18, 9, 0, 0);
  const next = nextDueAfter(cadence, friday);
  assert.equal(next.getDay(), 1, `expected Monday, got day ${next.getDay()}`);
  assert.equal(next.getDate(), 21);
  assert.equal(next.getHours(), 8);
  // Before 8am on a Wednesday, it is that Wednesday.
  const wednesday = new Date(2026, 8, 16, 7, 0, 0);
  assert.equal(nextDueAfter(cadence, wednesday).getDate(), 16);
  // Without the flag, Saturday is a day like any other.
  assert.equal(nextDueAfter({ kind: "daily", minuteOfDay: 8 * 60 }, friday).getDate(), 19);
});

test("add_schedule takes weekdays_only", async () => {
  setSchedulePersistence(false);
  resetSchedules();
  const result = await runTool(
    { name: "add_schedule", arguments: { name: "Build Check", prompt: "Did the build pass?", daily_at: "08:00", weekdays_only: true } },
    { memories: [], knowledge: [] }
  );
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /Every weekday at 8:00 AM/);
  resetSchedules();
});
