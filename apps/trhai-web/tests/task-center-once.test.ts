import test from "node:test";
import assert from "node:assert/strict";
import { cadenceFrom } from "../src/lib/taskCenter";

// The Tasks screen's form can make a schedule that runs once, at a date and time.

test("a one-time schedule from the form is a moment still to come, in local time", () => {
  const now = new Date(2026, 10, 4, 10, 0, 0, 0);
  assert.deepEqual(cadenceFrom({ kind: "once", at: "2026-11-04T15:00" }, now), { kind: "once", at: new Date(2026, 10, 4, 15, 0, 0, 0).toISOString() });
  assert.equal(cadenceFrom({ kind: "once", at: "2026-11-04T09:00" }, now), null, "passed");
  assert.equal(cadenceFrom({ kind: "once", at: "" }, now), null, "nothing picked yet");
  assert.equal(cadenceFrom({ kind: "once", at: "soon" }, now), null);
});
