import test from "node:test";
import assert from "node:assert/strict";
import { emptySeries, pushSample, type Sample } from "../src/lib/telemetryHistory.js";

// The strip's own memory. The question behind every case: can the trace end up
// implying a measurement that was never taken?

const sample = (cpu: number | null, memory: number | null, gpu: number | null): Sample => ({
  cpu: { fraction: cpu },
  memory: { fraction: memory },
  gpu: { fraction: gpu }
});

test("a good reading is recorded on every series", () => {
  const next = pushSample(emptySeries(), sample(0.5, 0.25, 0.75), 10);
  assert.deepEqual(next.cpu, [0.5]);
  assert.deepEqual(next.memory, [0.25]);
  assert.deepEqual(next.gpu, [0.75]);
});

test("a failed poll is a hole, not a skipped sample", () => {
  // The bug this exists for: a failed read used to do nothing at all, so the
  // trace carried straight on and the numbers beside it kept displaying the
  // last good values as though they were current.
  const first = pushSample(emptySeries(), sample(0.5, 0.5, 0.5), 10);
  const afterFailure = pushSample(first, null, 10);
  assert.deepEqual(afterFailure.cpu, [0.5, null]);
  assert.deepEqual(afterFailure.memory, [0.5, null]);
  assert.deepEqual(afterFailure.gpu, [0.5, null]);
});

test("the last good value is never carried over into the gap", () => {
  const series = pushSample(pushSample(emptySeries(), sample(0.9, 0.9, 0.9), 10), null, 10);
  assert.equal(series.cpu[1], null, "a repeated 0.9 would read as a machine sitting steady");
});

test("a sensor missing from an otherwise good read is its own hole", () => {
  // nvidia-smi absent on a machine whose CPU and memory read fine.
  const next = pushSample(emptySeries(), sample(0.4, 0.6, null), 10);
  assert.deepEqual(next.cpu, [0.4]);
  assert.deepEqual(next.gpu, [null]);
});

test("the series never grows past its limit", () => {
  let series = emptySeries();
  for (let i = 0; i < 50; i += 1) series = pushSample(series, sample(0.1, 0.1, 0.1), 30);
  assert.equal(series.cpu.length, 30);
  assert.equal(series.memory.length, 30);
  assert.equal(series.gpu.length, 30);
});

test("the oldest samples are the ones dropped", () => {
  let series = emptySeries();
  for (const value of [0.1, 0.2, 0.3, 0.4]) series = pushSample(series, sample(value, 0, 0), 2);
  assert.deepEqual(series.cpu, [0.3, 0.4]);
});

test("a run of failures leaves a run of holes rather than an empty series", () => {
  let series = pushSample(emptySeries(), sample(0.5, 0.5, 0.5), 10);
  for (let i = 0; i < 3; i += 1) series = pushSample(series, null, 10);
  assert.deepEqual(series.cpu, [0.5, null, null, null]);
});
