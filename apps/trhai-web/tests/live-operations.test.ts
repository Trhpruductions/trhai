import test from "node:test";
import assert from "node:assert/strict";
import {
  elapsed, runningEvent, visibleSteps, type ExecutionEvent
} from "../src/hooks/useExecutionEvents.js";

// The operations readout is the main screen's claim about what is happening
// right now. Every case here is about the same question the rest of this
// interface is built around: can it end up stating something that is not true?

function event(overrides: Partial<ExecutionEvent> = {}): ExecutionEvent {
  return {
    id: "e1",
    kind: "read",
    label: "List files",
    status: "ok",
    startedAt: new Date("2026-08-26T12:00:00.000Z").toISOString(),
    ...overrides
  };
}

test("the running step is the open one, not the last one", () => {
  // After a finished turn the newest row is a completed step. Treating "last"
  // as "current" would leave the screen reporting work that ended long ago.
  const events = [
    event({ id: "a", status: "running" }),
    event({ id: "b", status: "ok", durationMs: 40 })
  ];
  assert.equal(runningEvent(events)?.id, "a");
});

test("nothing is running once every step has closed", () => {
  const events = [
    event({ id: "a", status: "ok", durationMs: 12 }),
    event({ id: "b", status: "failed", durationMs: 8 })
  ];
  assert.equal(runningEvent(events), null);
});

test("the newest running step wins when several are open", () => {
  const events = [
    event({ id: "a", status: "running" }),
    event({ id: "b", status: "running" })
  ];
  assert.equal(runningEvent(events)?.id, "b");
});

test("an empty log reports nothing running", () => {
  assert.equal(runningEvent([]), null);
});

test("a finished step shows the duration the API measured", () => {
  // Not recomputed from the clock: the API timed the work, and the screen
  // repeats that number rather than producing its own.
  const finished = event({ durationMs: 1500 });
  assert.equal(elapsed(finished, Date.now()), "1.5s");
});

test("a running step counts forward from its own start", () => {
  const startedAt = new Date("2026-08-26T12:00:00.000Z");
  const running = event({ status: "running", startedAt: startedAt.toISOString() });
  assert.equal(elapsed(running, startedAt.getTime() + 2500), "2.5s");
});

test("sub-second work reads in milliseconds rather than 0.0s", () => {
  assert.equal(elapsed(event({ durationMs: 64 }), Date.now()), "64ms");
});

test("a clock that runs backwards never shows negative elapsed", () => {
  // now < startedAt is possible across a poll boundary or a clock adjustment,
  // and "-3.0s" on screen would be worse than a momentary zero.
  const startedAt = new Date("2026-08-26T12:00:00.000Z");
  const running = event({ status: "running", startedAt: startedAt.toISOString() });
  assert.equal(elapsed(running, startedAt.getTime() - 3000), "0ms");
});

test("an unparseable start time shows nothing rather than NaN", () => {
  const broken = event({ status: "running", startedAt: "not a date" });
  assert.equal(elapsed(broken, Date.now()), "");
});

// Which rows the compact readout gives its space to.

test("the newest steps are the ones shown", () => {
  const events = [1, 2, 3, 4, 5, 6, 7].map((n) =>
    event({ id: `e${n}`, status: "ok", durationMs: 5 }));
  assert.deepEqual(visibleSteps(events, 3).map((e) => e.id), ["e5", "e6", "e7"]);
});

test("a short log is shown whole rather than padded", () => {
  const events = [event({ id: "a" }), event({ id: "b" })];
  assert.deepEqual(visibleSteps(events, 5).map((e) => e.id), ["a", "b"]);
});

test("the running step stays in view when newer steps push it out", () => {
  // The case this exists for: a slow install still going while four quick
  // steps finish after it. Without the pin, the readout of what is happening
  // now would be showing four finished steps and not the running one.
  const events = [
    event({ id: "slow", status: "running" }),
    ...[1, 2, 3, 4].map((n) => event({ id: `q${n}`, status: "ok", durationMs: 5 }))
  ];
  const shown = visibleSteps(events, 3).map((e) => e.id);
  assert.ok(shown.includes("slow"), `running step dropped: ${shown.join(", ")}`);
  assert.equal(shown.length, 3, "pinning must not grow the list");
});

test("pinning does not duplicate a running step already in view", () => {
  const events = [
    event({ id: "a", status: "ok", durationMs: 5 }),
    event({ id: "b", status: "running" })
  ];
  const shown = visibleSteps(events, 3).map((e) => e.id);
  assert.deepEqual(shown, ["a", "b"]);
});

test("an empty log shows nothing", () => {
  assert.deepEqual(visibleSteps([], 4), []);
});
