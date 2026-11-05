import test from "node:test";
import assert from "node:assert/strict";
import { calendarWhen, upcomingOnCalendar } from "../src/lib/taskCenter.js";

// What the Tasks screen's calendar panel shows, and how it says when.

const now = new Date(2026, 10, 5, 12, 0); // Thursday 5 November 2026, noon, local.
const event = (title: string, startsAt: string, allDay = false) => ({ id: title, title, startsAt, ...(allDay ? { allDay } : {}) });

test("what is coming up, soonest first: an all-day event lasts its day, the rest until they start", () => {
  const events = [
    event("Next week", "2026-11-12T09:00"),
    event("Earlier today", "2026-11-05T09:00"),
    event("Later today", "2026-11-05T15:00"),
    event("All today", "2026-11-05T00:00", true),
    event("All yesterday", "2026-11-04T00:00", true)
  ];
  assert.deepEqual(upcomingOnCalendar(events, now).map((entry) => entry.title), ["All today", "Later today", "Next week"]);
  assert.deepEqual(upcomingOnCalendar([], now), []);
});

test("when it is, in a few words, with the year only when it is not this one", () => {
  assert.match(calendarWhen(event("a", "2026-11-06T15:00"), now), /6/);
  assert.match(calendarWhen(event("a", "2026-11-06T15:00"), now), /3:00/);
  assert.doesNotMatch(calendarWhen(event("a", "2026-11-06T15:00"), now), /2026/);
  assert.match(calendarWhen(event("a", "2027-01-06T15:00"), now), /2027/);
  assert.match(calendarWhen(event("a", "2026-11-06T00:00", true), now), /, all day$/);
});
