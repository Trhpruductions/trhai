import test from "node:test";
import assert from "node:assert/strict";
import { createToolActivity } from "../src/services/toolActivity.js";

// The state the terminal message rests on.
//
// The loop tells the user "No tool was executed during this attempt". That is
// an absolute claim, and it is only allowed from "none". These cases are about
// one question: can the state get back to "none" after something happened?

test("a fresh turn has touched nothing", () => {
  const activity = createToolActivity();
  assert.equal(activity.value, "none");
  assert.equal(activity.untouched, true);
});

test("execution is recorded before the call, so a throw still counts", () => {
  // The ordering that matters. markExecuted is called before dispatch, so a
  // tool that throws - possibly after writing half a file - leaves the turn
  // recorded as having executed rather than as untouched.
  const activity = createToolActivity();

  const runThrowingTool = () => {
    activity.markExecuted();
    throw new Error("the tool blew up");
  };

  assert.throws(runThrowingTool, /blew up/);
  assert.equal(activity.value, "executed");
  assert.equal(activity.untouched, false);
});

test("a confirmation is recorded, and nothing ran", () => {
  const activity = createToolActivity();
  activity.markExecuted();              // pre-dispatch, as the loop does
  activity.markAwaitingConfirmation();  // corrected once the tool refuses
  assert.equal(activity.value, "awaiting-confirmation");
  assert.equal(activity.untouched, false);
});

test("a call refused before running is recorded as blocked", () => {
  const activity = createToolActivity();
  activity.markBlocked();
  assert.equal(activity.value, "blocked");
  assert.equal(activity.untouched, false);
});

test("blocking never masks an execution that already happened", () => {
  // A repeat is only refused after the same call has already run twice, so
  // this is the ordinary case rather than a corner one. What matters is that
  // something ran, not that a later call did not.
  const activity = createToolActivity();
  activity.markExecuted();
  activity.markBlocked();
  assert.equal(activity.value, "executed");
});

test("no transition can return the state to none", () => {
  // The property the terminal message depends on. There is no setter, so this
  // is checked by exercising every transition from every reachable state.
  const transitions = ["markExecuted", "markAwaitingConfirmation", "markBlocked"] as const;

  for (const first of transitions) {
    for (const second of transitions) {
      const activity = createToolActivity();
      activity[first]();
      activity[second]();
      assert.notEqual(activity.value, "none", `${first} then ${second} returned to none`);
      assert.equal(activity.untouched, false, `${first} then ${second} reported untouched`);
    }
  }
});

test("the state exposes no way to assign a value", () => {
  // Accidental reset is meant to be unavailable, not merely discouraged.
  //
  // `value` is a getter with no setter, and modules are strict mode, so an
  // assignment throws rather than failing quietly. That is stronger than the
  // property this test was written to check: a future change that added a
  // setter would turn this from a throw into a silent success and fail here,
  // which is the point.
  const activity = createToolActivity();
  activity.markExecuted();

  const writable = activity as unknown as Record<string, unknown>;
  assert.throws(() => { writable.value = "none"; }, TypeError, "value must not be assignable");
  assert.equal(activity.value, "executed");
});

test("repeating a transition is harmless", () => {
  const activity = createToolActivity();
  activity.markExecuted();
  activity.markExecuted();
  assert.equal(activity.value, "executed");
});
