import test from "node:test";
import assert from "node:assert/strict";
import { daysBetween, describeDifference, parseDate, shiftDate } from "../src/services/dateMath.js";

// A fixed "today" so nothing here depends on when it is run.
const today = new Date(2026, 7, 17); // 17 August 2026

test("ISO dates are read", () => {
  const date = parseDate("2026-08-17", today);
  assert.equal(date?.getFullYear(), 2026);
  assert.equal(date?.getMonth(), 7);
  assert.equal(date?.getDate(), 17);
});

test("the forms people and models actually write", () => {
  const expected = new Date(2026, 7, 17).getTime();

  for (const input of [
    "17 August 2026",
    "August 17 2026",
    "August 17, 2026",
    "17 Aug 2026",
    "17th August 2026",
    "august 17th, 2026"
  ]) {
    assert.equal(parseDate(input, today)?.getTime(), expected, input);
  }
});

test("relative words are resolved against the given day", () => {
  assert.equal(parseDate("today", today)?.getTime(), new Date(2026, 7, 17).getTime());
  assert.equal(parseDate("tomorrow", today)?.getTime(), new Date(2026, 7, 18).getTime());
  assert.equal(parseDate("yesterday", today)?.getTime(), new Date(2026, 7, 16).getTime());
});

test("a date that does not exist is refused, not rolled forward", () => {
  // JavaScript turns 31 February into 3 March without complaint, which would
  // produce a confident answer about a day that never happened.
  assert.equal(parseDate("2026-02-31", today), null);
  assert.equal(parseDate("2026-13-01", today), null);
});

test("what is not a date is refused rather than guessed at", () => {
  assert.equal(parseDate("2026", today), null);
  assert.equal(parseDate("sometime next week", today), null);
  assert.equal(parseDate("", today), null);
  assert.equal(parseDate("the 17th", today), null);
});

test("days between two dates", () => {
  assert.equal(daysBetween(new Date(2026, 7, 17), new Date(2026, 7, 24)), 7);
  assert.equal(daysBetween(new Date(2026, 7, 24), new Date(2026, 7, 17)), -7);
  assert.equal(daysBetween(new Date(2026, 7, 17), new Date(2026, 7, 17)), 0);
});

test("a leap year is counted correctly", () => {
  // 2028 is a leap year, so February has 29 days.
  assert.equal(daysBetween(new Date(2028, 1, 28), new Date(2028, 2, 1)), 2);
  // 2026 is not.
  assert.equal(daysBetween(new Date(2026, 1, 28), new Date(2026, 2, 1)), 1);
});

test("a daylight-saving boundary does not lose or gain a day", () => {
  // The reason this counts in UTC. A local day across a clock change is 23 or
  // 25 hours, so dividing a local timestamp difference rounds to the wrong
  // count for exactly the two weeks a year nobody tests.
  assert.equal(daysBetween(new Date(2026, 2, 1), new Date(2026, 3, 1)), 31);
  assert.equal(daysBetween(new Date(2026, 9, 1), new Date(2026, 10, 1)), 31);
});

test("a year is 365 days, and a leap year 366", () => {
  assert.equal(daysBetween(new Date(2026, 0, 1), new Date(2027, 0, 1)), 365);
  assert.equal(daysBetween(new Date(2028, 0, 1), new Date(2029, 0, 1)), 366);
});

test("a difference is described in the user's direction", () => {
  const later = describeDifference("2026-08-17", "2026-08-24", today);
  assert.equal(later.ok, true);
  if (later.ok) {
    assert.match(later.value, /7 days after/);
  }

  const earlier = describeDifference("2026-08-24", "2026-08-17", today);
  assert.equal(earlier.ok, true);
  if (earlier.ok) {
    assert.match(earlier.value, /7 days before/);
  }
});

test("one day is singular", () => {
  const result = describeDifference("2026-08-17", "2026-08-18", today);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.value, /1 day after/);
    assert.doesNotMatch(result.value, /1 days/);
  }
});

test("the same day says so rather than reporting zero days", () => {
  const result = describeDifference("today", "2026-08-17", today);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.value, /same day/);
});

test("an unreadable date is refused and names which one", () => {
  const result = describeDifference("2026-08-17", "whenever", today);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /whenever/);
});

test("shifting a date forwards and back", () => {
  const forward = shiftDate("2026-08-17", 90, today);
  assert.equal(forward.ok, true);
  if (forward.ok) assert.match(forward.value, /November 15, 2026|15 November 2026/);

  const back = shiftDate("2026-08-17", -17, today);
  assert.equal(back.ok, true);
  if (back.ok) assert.match(back.value, /July 31, 2026|31 July 2026/);
});

test("shifting crosses a month and year boundary", () => {
  const result = shiftDate("2026-12-25", 10, today);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.value, /2027/);
});

test("a fractional or absurd number of days is refused", () => {
  assert.equal(shiftDate("2026-08-17", 1.5, today).ok, false);
  assert.equal(shiftDate("2026-08-17", 500_000, today).ok, false);
  assert.equal(shiftDate("2026-08-17", Number.NaN, today).ok, false);
});
