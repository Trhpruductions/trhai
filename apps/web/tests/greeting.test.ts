import test from "node:test";
import assert from "node:assert/strict";
import { greetingFor } from "../src/greeting";

const at = (hour: number) => new Date(2026, 0, 15, hour, 30, 0);

test("the greeting matches the part of the day", () => {
  assert.equal(greetingFor(at(9)), "Good morning");
  assert.equal(greetingFor(at(14)), "Good afternoon");
  assert.equal(greetingFor(at(20)), "Good evening");
});

test("the small hours are still evening, not morning", () => {
  // 2am is not "Good morning" to anyone who is awake at 2am.
  assert.equal(greetingFor(at(2)), "Good evening");
});

test("the boundaries fall on the later greeting", () => {
  assert.equal(greetingFor(new Date(2026, 0, 15, 5, 0, 0)), "Good morning");
  assert.equal(greetingFor(new Date(2026, 0, 15, 12, 0, 0)), "Good afternoon");
  assert.equal(greetingFor(new Date(2026, 0, 15, 18, 0, 0)), "Good evening");
});
