import test from "node:test";
import assert from "node:assert/strict";
import { barHeightPercent, ceilingMs, maxBars, trimSamples } from "../src/pulseTrace";

test("a fast round trip sits low, a slow one fills the strip", () => {
  // A fixed ceiling rather than one scaled to the highest reading: relative
  // scaling makes every strip look the same, so 9ms and 900ms would both fill
  // the height and the shape would carry nothing.
  assert.ok(barHeightPercent(8) < 15);
  assert.ok(barHeightPercent(100) > 40 && barHeightPercent(100) < 60);
  assert.equal(barHeightPercent(ceilingMs), 100);
});

test("a reading above the ceiling is clamped, not overflowed", () => {
  assert.equal(barHeightPercent(10_000), 100);
});

test("even the fastest reading is still visible", () => {
  // A bar of zero height reads as nothing having happened.
  assert.ok(barHeightPercent(0) >= 8);
  assert.ok(barHeightPercent(1) >= 8);
});

test("a failed check is drawn full height, not as a gap", () => {
  // Nothing happening and nothing answering look the same as empty space,
  // and they are not the same thing.
  assert.equal(barHeightPercent(null), 100);
});

test("the trace keeps only the most recent samples", () => {
  const many = Array.from({ length: maxBars + 12 }, (_, index) => ({ id: index, ms: 5 }));
  const kept = trimSamples(many);

  assert.equal(kept.length, maxBars);
  assert.equal(kept[kept.length - 1].id, maxBars + 11, "the newest sample must survive");
});

test("a short history is kept whole rather than padded", () => {
  // An app that has just opened shows one bar, because one round trip is all
  // that has happened. Filler would look identical on a machine where nothing
  // is working.
  const kept = trimSamples([{ id: 0, ms: 7 }]);
  assert.deepEqual(kept, [{ id: 0, ms: 7 }]);
});
