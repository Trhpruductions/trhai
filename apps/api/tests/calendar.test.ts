import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeEngine, type ScriptedReply } from "./helpers/fakeEngine.js";

// The calendar: what a person has on, read and changed by the assistant and through the routes, kept
// per caller, and included in what the privacy screen copies and erases. Against the real store, in a
// throwaway folder.

const dir = mkdtempSync(path.join(tmpdir(), "trhai-calendar-"));
const calendarFile = path.join(dir, "calendar.json");
process.env.ASCEND_WORKSPACE = dir;
process.env.ASSIST_CALENDAR_FILE = calendarFile;
process.env.ASSIST_ACCOUNTS_FILE = path.join(dir, "accounts.json");
process.env.ASSIST_PRIVACY_REQUESTS_FILE = path.join(dir, "privacy-requests.json");
process.env.ASSIST_AUDIT_FILE = path.join(dir, "audit.json");
process.env.TRHAI_LICENSE_FILE = path.join(dir, "license.json");
process.env.TRHAI_TRIAL_MARKER = path.join(dir, "elsewhere", "trial-started");
delete process.env.TRHAI_AUTHORITY;

const { availableTools, runTool } = await import("../src/services/agentTools.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { wantsCalendar, mentionsScheduling } = await import("../src/services/actionIntent.js");
const { permissionLevelOf } = await import("../src/services/toolPermissions.js");
const { addCalendarEvent, listEvents, reloadCalendarForTests, resetCalendar } = await import("../src/services/calendarStore.js");
const { calendarAccessFor, describeEvents, eventWhen, findEvent, isUpcoming, readEventMoment } = await import("../src/services/calendarTools.js");
const { createApp } = await import("../src/server.js");

const server = createApp().listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const key = "calendar-session";
const now = new Date(2026, 10, 5, 12, 0); // Thursday 5 November 2026, noon, local.
const context = (extra: Record<string, unknown> = {}) => ({
  memories: [], knowledge: [], calendar: calendarAccessFor(key), now: () => now, confirmedActions: new Set(["remove_event"]), ...extra
}) as never;
const tool = (name: string, args: Record<string, unknown>, extra?: Record<string, unknown>) => runTool({ name, arguments: args }, context(extra));
const names = (tools: Array<{ function: { name: string } }>) => tools.map((entry) => entry.function.name);

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; data: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { data?: unknown } | null;
  return { status: response.status, data: payload?.data ?? payload };
}

// ---------------------------------------------------------------- when it is offered

test("a request about the person's calendar is recognised, in the words people use", () => {
  for (const request of [
    "what's on my calendar?",
    "what is on my calendar this week",
    "put the dentist on my calendar on Friday at 3",
    "add lunch with Sam to my calendar",
    "take the dentist off my calendar",
    "check my diary for Tuesday",
    "do I have anything on Tuesday?",
    "am I free tomorrow?",
    "what have I got on tomorrow?",
    "when is my next appointment?",
    "what's my next meeting?",
    "book a dentist appointment for Friday",
    "add an appointment with the vet on the 12th"
  ]) {
    assert.equal(wantsCalendar(request), true, request);
  }
});

test("a calendar app, a question about the word, someone else's calendar and the rest are not it", () => {
  for (const request of [
    "build me a calendar app",
    "add a calendar view to my website",
    "what is a calendar?",
    "explain what a lunar calendar is",
    "how many days are in a calendar year",
    "check my Google calendar",
    "remind me every day at 9 to stretch",
    "add buy milk to my to-do list",
    "what time is it?",
    "hello"
  ]) {
    assert.equal(wantsCalendar(request), false, request);
  }
});

test("the tools are offered for it and withheld otherwise, and a question may read but not change it", () => {
  assert.ok(names(availableTools(true)).includes("add_event"));
  const withheld = names(availableTools(true, { calendar: false }));
  for (const name of ["list_events", "add_event", "remove_event"]) assert.equal(withheld.includes(name), false, name);
  const onlyAsking = names(availableTools(false, { writes: false, calendar: true }));
  assert.ok(onlyAsking.includes("list_events"));
  assert.equal(onlyAsking.includes("add_event"), false);
  assert.equal(onlyAsking.includes("remove_event"), false);
});

test("reading is safe, adding makes a change, and taking one off asks first", async () => {
  assert.equal(permissionLevelOf("list_events"), 1);
  assert.equal(permissionLevelOf("add_event"), 2);
  assert.equal(permissionLevelOf("remove_event"), 3);
  resetCalendar();
  await tool("add_event", { title: "Dentist", at: "2026-11-06 15:00" });
  const unconfirmed = await tool("remove_event", { event: "Dentist" }, { confirmedActions: new Set() });
  assert.equal(listEvents(key).length, 1, `it was not removed without asking: ${unconfirmed.content}`);
});

// ---------------------------------------------------------------- reading what the model wrote

test("a date and a time, or a date for all day, and nothing looser", () => {
  assert.deepEqual(readEventMoment("2026-11-06 15:00"), { ok: true, startsAt: "2026-11-06T15:00", allDay: false });
  assert.deepEqual(readEventMoment("2026-11-06T09:05"), { ok: true, startsAt: "2026-11-06T09:05", allDay: false });
  assert.deepEqual(readEventMoment(" 2026-11-06 "), { ok: true, startsAt: "2026-11-06T00:00", allDay: true });
  for (const loose of ["Friday", "tomorrow at 3", "11/06/2026", "", "2026-02-30", "2026-11-06 25:00", "2026-13-01 10:00"]) {
    assert.equal(readEventMoment(loose).ok, false, loose);
  }
});

test("when an event is, in words, and whether it is still to come", () => {
  assert.equal(eventWhen({ startsAt: "2026-11-06T15:00" }), "Fri 6 Nov 2026 at 3:00 PM");
  assert.equal(eventWhen({ startsAt: "2026-11-06T00:00", allDay: true }), "Fri 6 Nov 2026, all day");
  const event = (startsAt: string, allDay = false) => ({ id: "e", title: "t", startsAt, ...(allDay ? { allDay } : {}) });
  assert.equal(isUpcoming(event("2026-11-05T13:00"), now), true);
  assert.equal(isUpcoming(event("2026-11-05T11:00"), now), false, "earlier today has started");
  assert.equal(isUpcoming(event("2026-11-05T00:00", true), now), true, "an all-day event lasts the day");
  assert.equal(isUpcoming(event("2026-11-04T00:00", true), now), false);
});

// ---------------------------------------------------------------- the tools

test("an empty calendar says so, rather than denying the feature", async () => {
  resetCalendar();
  const result = await tool("list_events", {});
  assert.equal(result.ok, true);
  assert.equal(result.content, "The calendar is empty.");
});

test("an event is added and really on the calendar, and comes back soonest first with its number", async () => {
  resetCalendar();
  const added = await tool("add_event", { title: "Dentist", at: "2026-11-06 15:00", notes: "Bring the X-rays" });
  assert.equal(added.ok, true);
  assert.equal(added.content, "Added to your calendar: Fri 6 Nov 2026 at 3:00 PM: Dentist");
  await tool("add_event", { title: "Sam's birthday", at: "2026-11-05" });
  assert.deepEqual(listEvents(key).map((event) => event.title), ["Sam's birthday", "Dentist"]);
  assert.equal(listEvents(key)[1].notes, "Bring the X-rays");
  assert.equal(listEvents(key)[0].allDay, true);

  const list = await tool("list_events", {});
  assert.equal(list.content, "2 events coming up:\n1. Thu 5 Nov 2026, all day: Sam's birthday\n2. Fri 6 Nov 2026 at 3:00 PM: Dentist (Bring the X-rays)");
});

test("one day can be read, and the numbers are the same as in the whole calendar", async () => {
  resetCalendar();
  await tool("add_event", { title: "Dentist", at: "2026-11-06 15:00" });
  await tool("add_event", { title: "Vet", at: "2026-11-09 10:00" });
  const day = await tool("list_events", { on: "2026-11-09" });
  assert.equal(day.content, "1 event that day:\n2. Mon 9 Nov 2026 at 10:00 AM: Vet");
  assert.equal((await tool("list_events", { on: "2026-11-10" })).content, "Nothing is on the calendar on Tue 10 Nov 2026.");
  assert.equal((await tool("list_events", { on: "Tuesday" })).ok, false);
});

test("what has passed is not coming up, and is there when all of it is asked for", () => {
  const events = [{ id: "a", title: "Last week", startsAt: "2026-10-28T10:00" }, { id: "b", title: "Tomorrow", startsAt: "2026-11-06T10:00" }];
  assert.equal(describeEvents(events, now), "1 event coming up:\n2. Fri 6 Nov 2026 at 10:00 AM: Tomorrow");
  assert.match(describeEvents(events, now, "all"), /^2 events:\n1\. Wed 28 Oct 2026 at 10:00 AM: Last week\n2\./);
  assert.equal(describeEvents([events[0]], now), "Nothing is coming up. The calendar has 1 past event.");
});

test("the time comes from the user's own words where they said it, as for a schedule", async () => {
  resetCalendar();
  const added = await tool("add_event", { title: "Dentist", at: "2026-11-06 03:00" }, { request: "put the dentist on my calendar on Friday at 3 pm" });
  assert.match(added.content, /Fri 6 Nov 2026 at 3:00 PM/);
  // And a date alone with a time in the words is not all day.
  const dated = await tool("add_event", { title: "Vet", at: "2026-11-09" }, { request: "the vet on Monday at 10:30 am" });
  assert.match(dated.content, /Mon 9 Nov 2026 at 10:30 AM/);
});

test("the same event is said, not added twice; a day that has passed is refused; bad input adds nothing", async () => {
  resetCalendar();
  await tool("add_event", { title: "Dentist", at: "2026-11-06 15:00" });
  const again = await tool("add_event", { title: "dentist ", at: "2026-11-06 15:00" });
  assert.equal(again.ok, true, "a success, so the model does not reword it until one gets past");
  assert.match(again.content, /^Already on your calendar/);
  assert.equal(listEvents(key).length, 1);

  const past = await tool("add_event", { title: "Old", at: "2025-11-06 15:00" });
  assert.equal(past.ok, false);
  assert.match(past.content, /has already passed\. Nothing was added\./);
  // Earlier today still counts: the person may be noting what is on today.
  assert.equal((await tool("add_event", { title: "This morning", at: "2026-11-05 09:00" })).ok, true);

  for (const [args, expected] of [
    [{ at: "2026-11-06 15:00" }, /needs what the event is/],
    [{ title: "No date" }, /needs when it is/],
    [{ title: "Loose", at: "Friday" }, /not a date this can read.*Nothing was added\./],
    [{ title: "x".repeat(201), at: "2026-11-06 15:00" }, /one short line/],
    [{ title: "Long notes", at: "2026-11-06 15:00", notes: "x".repeat(1001) }, /Notes are at most/]
  ] as const) {
    const refused = await tool("add_event", args);
    assert.equal(refused.ok, false, JSON.stringify(args));
    assert.match(refused.content, expected);
  }
  assert.equal(listEvents(key).length, 2);
});

test("an event is found by number or words, and never guessed between several", async () => {
  resetCalendar();
  await tool("add_event", { title: "Dentist check-up", at: "2026-11-06 15:00" });
  await tool("add_event", { title: "Dentist cleaning", at: "2026-11-09 15:00" });
  await tool("add_event", { title: "Vet", at: "2026-11-10 15:00" });
  const events = listEvents(key);
  assert.equal(findEvent(events, "2.").kind, "one");
  assert.equal(findEvent(events, "VET").kind, "one");
  assert.equal(findEvent(events, "dentist").kind, "several");
  assert.equal(findEvent(events, "99").kind, "none");
  assert.equal(findEvent(events, "!!!").kind, "none");

  const several = await tool("remove_event", { event: "dentist" });
  assert.equal(several.ok, false);
  assert.match(several.content, /could mean any of these.*\n1\. Fri 6 Nov.*\n2\. Mon 9 Nov/s);
  assert.equal(listEvents(key).length, 3);

  const removed = await tool("remove_event", { event: "3" });
  assert.equal(removed.ok, true);
  assert.equal(removed.content, "Removed from your calendar: Tue 10 Nov 2026 at 3:00 PM: Vet");
  assert.equal(listEvents(key).length, 2);

  const nothing = await tool("remove_event", { event: "the moon" });
  assert.match(nothing.content, /No event matches "the moon"\. The calendar:\n2 events:/);
});

test("without a calendar to reach, each tool says so instead of pretending", async () => {
  const bare = { memories: [], knowledge: [], confirmedActions: new Set(["remove_event"]) } as never;
  for (const [name, args] of [["list_events", {}], ["add_event", { title: "x", at: "2026-11-06" }], ["remove_event", { event: "1" }]] as const) {
    const result = await runTool({ name, arguments: args }, bare);
    assert.equal(result.ok, false, name);
    assert.match(result.content, /no calendar here/i, name);
  }
});

// ---------------------------------------------------------------- the store

test("it survives a restart, in a protected file, and one caller's calendar is not another's", () => {
  resetCalendar();
  addCalendarEvent("one", { id: "a", title: "Mine", startsAt: "2026-12-25T10:00" });
  addCalendarEvent("two", { id: "b", title: "Theirs", startsAt: "2026-12-26T10:00" });
  assert.equal(existsSync(calendarFile), true);
  reloadCalendarForTests();
  assert.deepEqual(listEvents("one").map((event) => event.title), ["Mine"]);
  assert.deepEqual(listEvents("two").map((event) => event.title), ["Theirs"]);
  assert.equal(addCalendarEvent("one", { id: "c", title: "   ", startsAt: "2026-12-25T10:00" }), null);
  assert.equal(addCalendarEvent("one", { id: "c", title: "Bad day", startsAt: "2026-02-30T10:00" }), null);
});

// ---------------------------------------------------------------- the routes

test("the screen's routes add, read and remove, for one session, and refuse what is not a date", async () => {
  resetCalendar();
  const sessionId = "route-session";
  const added = await call("POST", "/v1/calendar", { sessionId, title: "Dentist", at: "2030-01-15 15:00", notes: "Bring the X-rays" });
  assert.equal(added.status, 201);
  assert.equal(added.data.event.startsAt, "2030-01-15T15:00");
  const allDay = await call("POST", "/v1/calendar", { sessionId, title: "Holiday", at: "2030-01-20" });
  assert.equal(allDay.data.event.allDay, true);

  const read = await call("GET", `/v1/calendar?sessionId=${sessionId}`);
  assert.deepEqual(read.data.events.map((event: { title: string }) => event.title), ["Dentist", "Holiday"]);
  assert.deepEqual((await call("GET", "/v1/calendar?sessionId=someone-else")).data.events, []);

  for (const body of [{ sessionId, at: "2030-01-15 15:00" }, { sessionId, title: "No date" }, { sessionId, title: "Loose", at: "Friday" }, { sessionId, title: "x".repeat(201), at: "2030-01-15" }]) {
    assert.equal((await call("POST", "/v1/calendar", body)).status, 400, JSON.stringify(body).slice(0, 50));
  }

  const response = await fetch(`${base}/v1/calendar/${added.data.event.id}?sessionId=${sessionId}`, { method: "DELETE" });
  assert.equal(response.status, 204);
  assert.equal((await call("DELETE", `/v1/calendar/${added.data.event.id}?sessionId=${sessionId}`)).status, 404);
  assert.equal((await call("GET", `/v1/calendar?sessionId=${sessionId}`)).data.events.length, 1);
});

// ---------------------------------------------------------------- the privacy screen

test("what the privacy screen says is held, copies and erases includes the calendar", async () => {
  resetCalendar();
  const sessionId = "privacy-calendar";
  await call("POST", "/v1/calendar", { sessionId, title: "Private appointment", at: "2030-03-01 09:00" });
  await call("POST", "/v1/calendar", { sessionId: "another-session", title: "Someone else's", at: "2030-03-01 09:00" });

  const summary = await call("GET", `/v1/privacy/summary?sessionId=${sessionId}`);
  assert.equal(summary.status, 200, JSON.stringify(summary.data).slice(0, 200));
  assert.equal(summary.data.held.calendarEvents, 1);

  const copy = await call("GET", `/v1/privacy/export?sessionId=${sessionId}`);
  assert.equal(copy.status, 200, JSON.stringify(copy.data).slice(0, 200));
  assert.match(JSON.stringify(copy.data), /Private appointment/);
  assert.doesNotMatch(JSON.stringify(copy.data), /Someone else's/);

  const erased = await call("POST", "/v1/privacy/erase", { sessionId, confirm: "ERASE", scope: { ownData: true } });
  assert.equal(erased.status, 200);
  assert.equal(erased.data.removed.calendarEvents, 1);
  assert.deepEqual(listEvents(sessionId), []);
  assert.equal(listEvents("another-session").length, 1, "and nobody else's");
});

// ---------------------------------------------------------------- through the loop

async function run(question: string, replies: ScriptedReply[]) {
  const engine = await fakeEngine({ models: ["llama3.1-8b"], reply: replies });
  const config = { baseUrl: engine.baseUrl, model: "llama3.1:8b", modelFromEnv: true, timeoutMs: 5000 };
  try {
    return { result: await runAgent(config, question, { memories: [], knowledge: [], calendar: calendarAccessFor(key) } as never), engine };
  } finally {
    engine.server.close();
  }
}

test("asked about the calendar the model has the tools, and asked for something else it does not", async () => {
  const asked = await run("what's on my calendar?", [{ message: { content: "Nothing." } }]);
  assert.ok(names(asked.engine.chats[0]?.tools ?? []).includes("list_events"));
  const other = await run("list three facts about the moon", [{ message: { content: "It has no air." } }]);
  assert.equal(names(other.engine.chats[0]?.tools ?? []).includes("list_events"), false);
});

test("what was added is in the answer, whatever the model goes on to say", async () => {
  resetCalendar();
  const { result } = await run("put the dentist on my calendar on 2030-06-07 at 3 pm", [
    { message: { content: "", tool_calls: [{ function: { name: "add_event", arguments: { title: "Dentist", at: "2030-06-07 15:00" } } }] } },
    { message: { content: "All done! It's on there." } }
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.toolsUsed.map((used) => used.name), ["add_event"]);
  assert.match(result.text, /Added to your calendar: Fri 7 Jun 2030 at 3:00 PM: Dentist/);
  assert.equal(listEvents(key).length, 1);
});

test("a repeating reminder is still a schedule, not an event", () => {
  assert.equal(wantsCalendar("remind me every day at 9 to stretch"), false);
  assert.equal(mentionsScheduling("remind me every day at 9 to stretch"), true);
});
