import test from "node:test";
import assert from "node:assert/strict";
import { breathe, gaugeTone, visualForState } from "../src/components/coreVisual.js";
import type { CoreState } from "../src/components/Core.js";

// The core is presence rather than an instrument, but its state still comes
// from real work — the orchestrator sets it from the tool genuinely running.
// These pin down the part a GPU is not needed to check: that each state is
// visually distinct, and that the distinctions match what the state means.

const every: CoreState[] = [
  "idle", "listening", "thinking", "searching", "reading", "writing",
  "analysing", "executing", "speaking", "success", "error", "offline"
];

test("every core state has its own visual", () => {
  for (const state of every) {
    const visual = visualForState(state);
    assert.ok(visual, `${state} has no visual`);
    assert.equal(visual.color.length, 3);
    assert.equal(visual.accent.length, 3);
  }
});

test("no two states are drawn identically", () => {
  // A state the user cannot tell apart from another is the same as not having
  // it: the screen would claim to distinguish searching from writing while
  // showing one picture for both.
  const seen = new Map<string, CoreState>();
  for (const state of every) {
    const visual = visualForState(state);
    const key = JSON.stringify([visual.color, visual.energy, visual.spin, visual.converge]);
    const clash = seen.get(key);
    assert.equal(clash, undefined, `${state} looks exactly like ${clash}`);
    seen.set(key, state);
  }
});

test("energy and convergence stay inside the ranges the shader expects", () => {
  for (const state of every) {
    const { energy, converge, alive, color, accent } = visualForState(state);
    assert.ok(energy >= 0 && energy <= 1, `${state} energy ${energy}`);
    assert.ok(converge >= -1 && converge <= 1, `${state} converge ${converge}`);
    assert.ok(alive >= 0 && alive <= 1, `${state} alive ${alive}`);
    for (const channel of [...color, ...accent]) {
      assert.ok(channel >= 0 && channel <= 1, `${state} channel ${channel}`);
    }
  }
});

test("searching looks outward and building looks inward", () => {
  // The direction is the meaning: searching is going somewhere to look, while
  // writing and executing form output at the centre.
  assert.ok(visualForState("searching").converge < 0);
  assert.ok(visualForState("writing").converge > 0);
  assert.ok(visualForState("executing").converge > 0);
});

test("a running tool is the most energetic thing on screen", () => {
  const executing = visualForState("executing").energy;
  for (const state of every) {
    if (state === "executing") continue;
    assert.ok(
      visualForState(state).energy < executing,
      `${state} is at least as energetic as a running tool`
    );
  }
});

test("idle is quiet but not dead", () => {
  const idle = visualForState("idle");
  assert.ok(idle.energy > 0, "idle has no energy at all");
  assert.ok(idle.energy < 0.35, "idle is too busy to read as idle");
  assert.equal(idle.alive, 1);
});

test("unreachable drains the colour", () => {
  // The one state that is genuinely about the machine being gone. It has to be
  // obvious at a glance rather than a slightly different blue.
  const offline = visualForState("offline");
  assert.equal(offline.alive, 0);
  assert.ok(offline.energy < visualForState("idle").energy);
});

test("the work effects stay inside the ranges the shader expects", () => {
  for (const state of every) {
    const { traffic, ripple, scan, glitch } = visualForState(state);
    assert.ok(traffic >= 0 && traffic <= 1, `${state} traffic ${traffic}`);
    assert.ok(ripple >= -1 && ripple <= 1, `${state} ripple ${ripple}`);
    assert.ok(scan >= 0 && scan <= 1, `${state} scan ${scan}`);
    assert.ok(glitch >= 0 && glitch <= 1, `${state} glitch ${glitch}`);
  }
});

test("a voice going out sends rings out, and listening draws them in", () => {
  assert.ok(visualForState("speaking").ripple > 0);
  assert.ok(visualForState("listening").ripple < 0);
  // Nothing is said or heard while working, so no rings then.
  for (const state of ["thinking", "searching", "reading", "writing", "analysing", "executing"] as CoreState[]) {
    assert.equal(visualForState(state).ripple, 0, `${state} sends rings`);
  }
});

test("only a fault makes the drawing slip", () => {
  for (const state of every) {
    if (state === "error") assert.ok(visualForState(state).glitch > 0);
    else assert.equal(visualForState(state).glitch, 0, `${state} glitches`);
  }
});

test("nothing runs along the network when no work can be happening", () => {
  // Signals are the network busy. A machine that cannot be reached, or work
  // that has just failed, must not look busy.
  assert.equal(visualForState("offline").traffic, 0);
  assert.equal(visualForState("error").traffic, 0);
  assert.ok(visualForState("idle").traffic < visualForState("thinking").traffic);
  assert.equal(
    Math.max(...every.map((state) => visualForState(state).traffic)),
    visualForState("executing").traffic,
    "something is busier than a running tool"
  );
});

test("the sweep is for looking, not for talking", () => {
  assert.equal(visualForState("searching").scan, 1);
  assert.equal(visualForState("speaking").scan, 0);
  assert.equal(visualForState("idle").scan, 0);
});

test("an unknown state falls back rather than rendering nothing", () => {
  assert.deepEqual(
    visualForState("not-a-state" as CoreState),
    visualForState("idle")
  );
});

// --- breathing ------------------------------------------------------------

test("breathing stays in range across a long run", () => {
  for (let second = 0; second < 600; second += 0.25) {
    const value = breathe(second);
    assert.ok(value >= 0 && value <= 1, `breathe(${second}) = ${value}`);
  }
});

test("breathing does not repeat on a short loop", () => {
  // A single sine reads as mechanical within about ten seconds, which is the
  // whole reason there are three at incommensurate rates. This checks the
  // rhythm has genuinely not come back around by then.
  const start = breathe(0);
  let matches = 0;
  for (let second = 4; second < 60; second += 0.5) {
    if (Math.abs(breathe(second) - start) < 0.001) matches += 1;
  }
  assert.ok(matches < 4, `the rhythm returned to its start ${matches} times in a minute`);
});

test("breathing actually moves", () => {
  const samples = Array.from({ length: 40 }, (_, i) => breathe(i * 0.4));
  const low = Math.min(...samples);
  const high = Math.max(...samples);
  assert.ok(high - low > 0.5, `breathing only spanned ${(high - low).toFixed(3)}`);
});

// --- gauge colour ---------------------------------------------------------

test("a consumption gauge warns as it fills", () => {
  assert.equal(gaugeTone(0.2), "ok");
  assert.equal(gaugeTone(0.75), "warn");
  assert.equal(gaugeTone(0.95), "danger");
});

test("health is not alarming when everything is passing", () => {
  // The bug this pins down: health at 100% was drawn danger-red, because the
  // tone rule assumed a full ring meant a full disk. A red alarm printed over
  // the words "all passing" is worse than no colour at all.
  assert.equal(gaugeTone(1, true), "ok");
  assert.equal(gaugeTone(0.8, true), "ok");
  assert.equal(gaugeTone(0.25, true), "warn");
  assert.equal(gaugeTone(0.05, true), "danger");
});

test("no reading is its own tone, never a passing one", () => {
  assert.equal(gaugeTone(null), "unknown");
  assert.equal(gaugeTone(undefined), "unknown");
  assert.equal(gaugeTone(null, true), "unknown");
});
