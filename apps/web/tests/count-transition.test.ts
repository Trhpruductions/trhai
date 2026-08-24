import test from "node:test";
import assert from "node:assert/strict";
import { interpolateCount } from "../src/countTransition.js";

// A rolling stat is only honest if it always lands exactly on the real value
// it was polled to show. These tests hold that: whatever happens in between,
// the endpoints are never approximate.

test("before the transition starts, the old value still shows", () => {
  assert.equal(interpolateCount(3, 9, 0, 500), 3);
});

test("once the duration has passed, the real new value shows exactly", () => {
  assert.equal(interpolateCount(3, 9, 500, 500), 9);
});

test("well past the duration still lands on the exact value, not an overshoot", () => {
  assert.equal(interpolateCount(3, 9, 5000, 500), 9);
});

test("midway sits strictly between the two real values", () => {
  const mid = interpolateCount(0, 100, 250, 500);
  assert.ok(mid > 0 && mid < 100, `expected 0 < ${mid} < 100`);
});

test("a falling count still ends exactly on the lower value", () => {
  assert.equal(interpolateCount(9, 2, 500, 500), 2);
});

test("equal endpoints never wobble off the value", () => {
  assert.equal(interpolateCount(4, 4, 250, 500), 4);
});

test("a zero or negative duration jumps straight to the real value", () => {
  assert.equal(interpolateCount(1, 8, 0, 0), 8);
  assert.equal(interpolateCount(1, 8, 0, -100), 8);
});

test("the result is always a whole number", () => {
  for (let elapsed = 0; elapsed <= 500; elapsed += 37) {
    const value = interpolateCount(1, 6, elapsed, 500);
    assert.equal(value, Math.round(value));
  }
});
