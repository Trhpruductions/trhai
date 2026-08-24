import test from "node:test";
import assert from "node:assert/strict";
import { rmsAmplitude, smoothAmplitude } from "../src/audioAmplitude.js";

// The core is only allowed to move for a true reason, and amplitude is meant
// to be one of them. These tests are the guarantee that the number behind the
// motion actually tracks loudness — silence reads as silence, a loud frame
// reads louder than a quiet one — rather than becoming decoration that moves
// whether or not anything is being said.

/** A time-domain frame at a fixed loudness, byte-encoded like the real API. */
function frameAt(amplitude: number, length = 32): Uint8Array {
  const samples = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    // Alternates above and below the silence line the way a real waveform
    // does, rather than sitting at a constant offset no real signal would.
    const swing = i % 2 === 0 ? amplitude : -amplitude;
    samples[i] = Math.max(0, Math.min(255, Math.round(128 + swing * 128)));
  }
  return samples;
}

test("silence reads as zero", () => {
  const silent = new Uint8Array(32).fill(128);
  assert.equal(rmsAmplitude(silent), 0);
});

test("an empty frame is silence, not a crash", () => {
  assert.equal(rmsAmplitude(new Uint8Array(0)), 0);
});

test("a louder frame reads louder", () => {
  const quiet = rmsAmplitude(frameAt(0.1));
  const loud = rmsAmplitude(frameAt(0.6));
  assert.ok(loud > quiet, `expected loud (${loud}) > quiet (${quiet})`);
});

test("amplitude never leaves 0..1 even at full-scale input", () => {
  const maxed = frameAt(1);
  const value = rmsAmplitude(maxed);
  assert.ok(value >= 0 && value <= 1, `out of range: ${value}`);
});

test("smoothing moves toward the new reading without jumping straight to it", () => {
  const next = smoothAmplitude(0.2, 0.8);
  assert.ok(next > 0.2 && next < 0.8, `expected 0.2 < ${next} < 0.8`);
});

test("smoothing already at the target stays there", () => {
  assert.equal(smoothAmplitude(0.5, 0.5), 0.5);
});

test("repeated smoothing converges on the target", () => {
  let value = 0;
  for (let i = 0; i < 50; i += 1) value = smoothAmplitude(value, 1);
  assert.ok(value > 0.99, `expected convergence near 1, got ${value}`);
});

test("an extreme smoothing factor is clamped rather than passed through", () => {
  // Factor 0 would never move and factor 5 would overshoot past the target;
  // neither is a valid weight for a linear blend.
  assert.ok(smoothAmplitude(0, 1, 0) > 0);
  assert.ok(smoothAmplitude(0, 1, 5) <= 1);
});
