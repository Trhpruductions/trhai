import test from "node:test";
import assert from "node:assert/strict";
import { concatSamples, encodeWav, resampleMono, targetSampleRate } from "../src/lib/wav.js";

// The encoder has to be exactly right: whisper.cpp reads the header and a
// wrong byte there means it either refuses the file or, worse, reads the
// samples at the wrong rate and transcribes nonsense. These check the bytes
// rather than trusting the arithmetic.

async function bytesOf(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

function ascii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(view.getUint8(offset + index));
  return out;
}

test("the encoded header is a real 16 kHz mono 16-bit WAV", async () => {
  const view = await bytesOf(encodeWav(new Float32Array(8)));

  assert.equal(ascii(view, 0, 4), "RIFF");
  assert.equal(ascii(view, 8, 4), "WAVE");
  assert.equal(ascii(view, 12, 4), "fmt ");
  assert.equal(view.getUint16(20, true), 1, "must be PCM");
  assert.equal(view.getUint16(22, true), 1, "must be mono");
  assert.equal(view.getUint32(24, true), targetSampleRate);
  assert.equal(view.getUint16(34, true), 16, "must be 16-bit");
  assert.equal(ascii(view, 36, 4), "data");
});

test("the declared sizes match the actual bytes", async () => {
  const samples = new Float32Array(100);
  const blob = encodeWav(samples);
  const view = await bytesOf(blob);

  // 44-byte header plus two bytes per sample.
  assert.equal(blob.size, 44 + 200);
  assert.equal(view.getUint32(40, true), 200, "data chunk size");
  assert.equal(view.getUint32(4, true), 36 + 200, "RIFF size");
});

test("full-scale samples reach the limits without wrapping", async () => {
  // A sample past the limit that wrapped would land in the audio as a click,
  // which is why this clamps rather than trusting the caller.
  const view = await bytesOf(encodeWav(Float32Array.from([1, -1, 2, -2, 0])));

  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
  assert.equal(view.getInt16(48, true), 32767, "above 1 clamps, never wraps");
  assert.equal(view.getInt16(50, true), -32768, "below -1 clamps, never wraps");
  assert.equal(view.getInt16(52, true), 0);
});

test("resampling reduces the rate by the right ratio", () => {
  const input = new Float32Array(48_000);
  const output = resampleMono(input, 48_000, 16_000);
  // A second of 48 kHz becomes a second of 16 kHz.
  assert.equal(output.length, 16_000);
});

test("resampling at the same rate returns the samples untouched", () => {
  const input = Float32Array.from([0.1, 0.2, 0.3]);
  assert.equal(resampleMono(input, 16_000, 16_000), input);
});

test("resampling preserves the shape of the signal", () => {
  // A ramp stays a ramp: first sample intact, last near the input's last, and
  // monotonic throughout. This catches an off-by-one in the interpolation that
  // a length check alone would miss.
  const input = Float32Array.from({ length: 1000 }, (_, index) => index / 1000);
  const output = resampleMono(input, 48_000, 16_000);

  assert.equal(output[0], 0);
  assert.ok(output.at(-1)! > 0.98, `expected to reach the top of the ramp, got ${output.at(-1)}`);
  for (let index = 1; index < output.length; index += 1) {
    assert.ok(output[index] >= output[index - 1], `ramp reversed at ${index}`);
  }
});

test("empty input survives both stages rather than throwing", () => {
  assert.equal(resampleMono(new Float32Array(0), 48_000).length, 0);
  assert.equal(encodeWav(new Float32Array(0)).size, 44, "header only");
});

test("captured chunks join in order", () => {
  const joined = concatSamples([
    Float32Array.from([1, 2]),
    Float32Array.from([3]),
    Float32Array.from([4, 5])
  ]);

  assert.deepEqual(Array.from(joined), [1, 2, 3, 4, 5]);
});

test("joining nothing is empty, not a crash", () => {
  assert.equal(concatSamples([]).length, 0);
});
