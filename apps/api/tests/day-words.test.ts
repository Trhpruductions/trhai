import test from "node:test";
import assert from "node:assert/strict";
import { dayAskedFor, localDay } from "../src/services/dayWords.js";

// Sunday 8 November 2026, mid-morning: the day the models got "next Friday" and "tomorrow" wrong on the card.
const sunday = new Date(2026, 10, 8, 10, 30);
const day = (request: string, now = sunday) => { const found = dayAskedFor(request, now); return found ? localDay(found) : null; };

test("the plain words for a day", () => {
  assert.equal(day("remind me today at 5 pm to lock up"), "2026-11-08");
  assert.equal(day("what's on tonight?"), "2026-11-08");
  assert.equal(day("remind me tomorrow at 3 pm to call the bank"), "2026-11-09");
  assert.equal(day("the day after tomorrow at noon"), "2026-11-10");
  assert.equal(day("in three days"), "2026-11-11");
  assert.equal(day("in 10 days"), "2026-11-18");
  assert.equal(day("in a week"), "2026-11-15");
  assert.equal(day("in two weeks"), "2026-11-22");
});

test("a weekday is the coming one, and next on that very day is a week away", () => {
  assert.equal(day("put the dentist on my calendar for next Friday at 2 pm"), "2026-11-13");
  assert.equal(day("the dentist on Friday at 2 pm"), "2026-11-13");
  assert.equal(day("this Wednesday"), "2026-11-11");
  assert.equal(day("remind me on Sunday to water the plants"), "2026-11-08", "a Sunday asked for on a Sunday is today");
  assert.equal(day("remind me next Sunday to water the plants"), "2026-11-15");
  assert.equal(day("coming Monday"), "2026-11-09");
});

test("dates, with or without a year, the next time they come round", () => {
  assert.equal(day("the vet on 12 November"), "2026-11-12");
  assert.equal(day("November 12th, the vet"), "2026-11-12");
  assert.equal(day("Nov 12 at 10 am"), "2026-11-12");
  assert.equal(day("on 2026-11-12 at 10:00"), "2026-11-12");
  assert.equal(day("12 November 2026"), "2026-11-12");
  assert.equal(day("November 12, 2026"), "2026-11-12");
  assert.equal(day("11/12/2026"), "2026-11-12");
  assert.equal(day("on 11/12"), "2026-11-12");
  assert.equal(day("on the 12th"), "2026-11-12");
  assert.equal(day("on the 3rd"), "2026-12-03", "the 3rd has gone this month");
  assert.equal(day("on 3 January"), "2027-01-03", "January has gone this year");
  assert.equal(day("on 31 November"), null, "no such day");
});

test("none, two, a repeat or a day gone: the model's reading stands", () => {
  assert.equal(day("remind me at 3 pm to call the bank"), null);
  assert.equal(day("tomorrow, or Friday if that is easier"), null);
  assert.equal(day("every Friday at 9 am"), null);
  assert.equal(day("each morning at 7"), null);
  assert.equal(day("every day at 9:15 am remind me to drink water"), null);
  assert.equal(day("on 12 November 2025"), null, "gone");
  assert.equal(day("on 3 January 2026"), null, "gone");
  assert.equal(day("what day of the week is 2026-11-12?"), "2026-11-12", "a date in a question is still a date; what to do with it is the caller's");
});
