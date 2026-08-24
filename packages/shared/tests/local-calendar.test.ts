import test from "node:test";
import assert from "node:assert/strict";
import {
  addEvent,
  dayOf,
  eventsOnDay,
  formatRelative,
  isImminent,
  isValidStart,
  parseEvents,
  readEvents,
  removeEvent,
  toLocalInput,
  upcomingEvents,
  writeEvents,
  type CalendarEvent
} from "../src/localCalendar.js";

const sample: CalendarEvent[] = [
  { id: "a", title: "Standup", startsAt: "2026-08-11T10:00" },
  { id: "b", title: "Review", startsAt: "2026-08-11T13:00" },
  { id: "c", title: "Gym", startsAt: "2026-08-12T18:00" }
];

test("events sort by start time regardless of insertion order", () => {
  const events = addEvent(
    addEvent([], { id: "late", title: "Late", startsAt: "2026-08-11T18:00" }),
    { id: "early", title: "Early", startsAt: "2026-08-11T08:00" }
  );

  assert.deepEqual(events.map((event) => event.id), ["early", "late"]);
});

test("an event with no title or a bad time is refused", () => {
  assert.deepEqual(addEvent([], { id: "x", title: "   ", startsAt: "2026-08-11T10:00" }), []);
  assert.deepEqual(addEvent([], { id: "x", title: "Real", startsAt: "not-a-time" }), []);
  // Matches the shape but is not a real date.
  assert.deepEqual(addEvent([], { id: "x", title: "Real", startsAt: "2026-02-31T10:00" }), []);
});

test("a valid start is recognized and round-trips", () => {
  assert.equal(isValidStart("2026-08-11T10:00"), true);
  assert.equal(isValidStart("2026-08-11"), false);
  assert.equal(isValidStart("2026-13-01T10:00"), false);

  const date = new Date(2026, 7, 11, 9, 5);
  assert.equal(toLocalInput(date), "2026-08-11T09:05");
  assert.equal(isValidStart(toLocalInput(date)), true);
});

test("upcoming events exclude ones that already started", () => {
  const now = new Date(2026, 7, 11, 11, 0);

  assert.deepEqual(
    upcomingEvents(sample, now).map((event) => event.id),
    ["b", "c"]
  );
});

test("upcoming events respect the limit", () => {
  const now = new Date(2026, 7, 11, 0, 0);

  assert.equal(upcomingEvents(sample, now, 2).length, 2);
});

test("day grouping uses the date prefix, not a parsed Date", () => {
  // Parsing to a Date and back shifts an event across midnight in some zones,
  // which puts it on the wrong day.
  assert.equal(dayOf(sample[0]), "2026-08-11");
  assert.deepEqual(
    eventsOnDay(sample, "2026-08-11").map((event) => event.id),
    ["a", "b"]
  );
  assert.deepEqual(eventsOnDay(sample, "2026-08-13"), []);
});

test("relative time is computed, not baked in", () => {
  const now = new Date(2026, 7, 11, 9, 15);

  assert.equal(formatRelative("2026-08-11T10:00", now), "in 45m");
  assert.equal(formatRelative("2026-08-11T13:00", now), "in 3h 45m");
  assert.equal(formatRelative("2026-08-11T11:15", now), "in 2h");
  assert.equal(formatRelative("2026-08-13T09:15", now), "in 2d");
  assert.equal(formatRelative("2026-08-11T09:15", now), "now");
  assert.equal(formatRelative("2026-08-11T08:00", now), "started");
});

test("relative time moves as the clock does", () => {
  // The regression this replaces: "in 45m" was a literal in the markup and was
  // still "in 45m" hours later.
  const early = formatRelative("2026-08-11T10:00", new Date(2026, 7, 11, 9, 0));
  const later = formatRelative("2026-08-11T10:00", new Date(2026, 7, 11, 9, 50));

  assert.notEqual(early, later);
  assert.equal(early, "in 1h");
  assert.equal(later, "in 10m");
});

test("removing an event drops only that one", () => {
  assert.deepEqual(removeEvent(sample, "b").map((event) => event.id), ["a", "c"]);
});

test("a corrupt stored calendar degrades to the events that are still valid", () => {
  assert.deepEqual(parseEvents("nope"), []);
  assert.deepEqual(
    parseEvents([
      { id: "ok", title: "Keep", startsAt: "2026-08-11T10:00" },
      { id: "ok", title: "Duplicate id", startsAt: "2026-08-11T11:00" },
      { id: "bad-time", title: "Drop", startsAt: "whenever" },
      { id: "no-title", title: "  ", startsAt: "2026-08-11T12:00" },
      null
    ]).map((event) => event.id),
    ["ok"]
  );
});

test("a hostile storage never throws", () => {
  const hostile = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    }
  } as unknown as Storage;

  assert.deepEqual(readEvents(hostile, "k"), []);
  assert.doesNotThrow(() => writeEvents(hostile, "k", sample));
});

test("a saved calendar round-trips", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  } as unknown as Storage;

  writeEvents(storage, "cal", sample);
  assert.deepEqual(readEvents(storage, "cal"), sample);
});

test("an event starting within the window is imminent", () => {
  const now = new Date(2026, 7, 11, 9, 15);
  assert.equal(isImminent("2026-08-11T09:20", now), true);
  assert.equal(isImminent("2026-08-11T09:30", now), true);
});

test("an event further out is not imminent", () => {
  const now = new Date(2026, 7, 11, 9, 15);
  assert.equal(isImminent("2026-08-11T09:31", now), false);
  assert.equal(isImminent("2026-08-11T11:00", now), false);
});

test("an event already started is not imminent", () => {
  const now = new Date(2026, 7, 11, 9, 15);
  // Urgency is for what is about to happen, not what already is — a started
  // event reads as "started" elsewhere in this screen, not as more urgent.
  assert.equal(isImminent("2026-08-11T09:00", now), false);
});

test("an event starting this instant is imminent", () => {
  const now = new Date(2026, 7, 11, 9, 15);
  assert.equal(isImminent("2026-08-11T09:15", now), true);
});

test("a custom threshold is honoured", () => {
  const now = new Date(2026, 7, 11, 9, 15);
  assert.equal(isImminent("2026-08-11T09:20", now, 3), false);
  assert.equal(isImminent("2026-08-11T09:18", now, 3), true);
});

test("an unparseable time is never imminent", () => {
  assert.equal(isImminent("not a date", new Date()), false);
});
