import test from "node:test";
import assert from "node:assert/strict";
import { analyse, analysisRate, visualTrack } from "../src/services/audioAnalysis.js";

// The analysis is checked against audio whose beats and parts are known exactly:
// made here, a sample at a time, so that nothing depends on a file or on ffmpeg.

const rate = analysisRate;
const TAU = Math.PI * 2;

/** A seeded white-noise source, so that every run hears the same hiss. */
function noiseSource(seed = 7) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2147483648 - 1;
  };
}

/** A kick on every beat, a hat on every off-beat, and a held chord under them. */
function drumTrack(seconds: number, bpm: number, options: { hats?: boolean; chord?: number } = {}): { samples: Float32Array; beats: number[] } {
  const { hats = true, chord = 0.05 } = options;
  const samples = new Float32Array(Math.round(seconds * rate));
  const beat = 60 / bpm;
  const noise = noiseSource();
  let lastHat = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / rate;
    const into = t % beat;
    let value = 0.9 * Math.sin(TAU * (45 * into + (120 * (1 - Math.exp(-35 * into))) / 35)) * Math.exp(-9 * into);
    if (hats) {
      const raw = noise();
      value += 0.25 * (raw - lastHat) * Math.exp(-60 * ((t + beat / 2) % beat));
      lastHat = raw;
    }
    value += chord * (Math.sin(TAU * 220 * t) + Math.sin(TAU * 277 * t) + Math.sin(TAU * 330 * t));
    samples[i] = value;
  }
  const beats: number[] = [];
  for (let b = 0; b * beat < seconds; b += 1) beats.push(b * beat);
  return { samples, beats };
}

const distanceToNearest = (value: number, among: number[]) => Math.min(...among.map((other) => Math.abs(other - value)));

for (const bpm of [90, 120, 150]) {
  test(`a steady ${bpm} BPM track gives its tempo and beats that land on its kicks`, () => {
    const { samples, beats: truth } = drumTrack(24, bpm);
    const analysis = analyse(samples);
    assert.ok(analysis.bpm !== null, "a steady beat is found");
    assert.ok(Math.abs((analysis.bpm as number) - bpm) <= 1.5, `${analysis.bpm} BPM, not ${bpm}`);
    assert.ok(Math.abs(analysis.beats.length - truth.length) <= 3, `${analysis.beats.length} beats for ${truth.length} kicks`);
    const off = analysis.beats.map((beat) => distanceToNearest(beat, truth)).sort((a, b) => a - b);
    assert.ok(off[Math.floor(off.length / 2)] < 0.03, `the median beat is ${off[Math.floor(off.length / 2)]} s from a kick`);
    assert.ok(off.filter((d) => d < 0.06).length >= off.length * 0.9, "nine in ten beats are within 60 ms of a kick");
    assert.ok(Math.abs(analysis.duration - 24) < 0.01);
  });
}

test("a hat-only, kick-less groove still gives the tempo", () => {
  const { samples } = drumTrack(24, 128, { hats: true, chord: 0 });
  // The kick is still there, so take it away: this checks the tempo does not hang on the low end alone.
  const filtered = new Float32Array(samples.length);
  let low = 0;
  for (let i = 0; i < samples.length; i += 1) {
    low += 0.08 * (samples[i] - low);
    filtered[i] = samples[i] - low;
  }
  const analysis = analyse(filtered);
  assert.ok(analysis.bpm !== null && Math.abs(analysis.bpm - 128) <= 2, `${analysis.bpm}`);
});

test("silence, a pure tone and noise have no beat, and nothing is invented", () => {
  assert.deepEqual([analyse(new Float32Array(rate * 12)).bpm, analyse(new Float32Array(rate * 12)).beats], [null, []]);
  const tone = Float32Array.from({ length: rate * 15 }, (_, i) => 0.5 * Math.sin((TAU * 440 * i) / rate));
  const steady = analyse(tone);
  assert.equal(steady.bpm, null, "a held note has no beat");
  const noise = noiseSource(3);
  const hiss = Float32Array.from({ length: rate * 20 }, () => 0.3 * noise());
  const random = analyse(hiss);
  assert.equal(random.bpm, null, "hiss has no beat");
  assert.deepEqual(random.beats, []);
});

test("loudness follows the song: quiet, loud, quiet", () => {
  const { samples } = drumTrack(36, 120, { hats: true, chord: 0.04 });
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / rate;
    samples[i] *= t < 12 ? 0.12 : t < 24 ? 1 : 0.12;
  }
  const { intensity } = analyse(samples);
  const mean = (from: number, to: number) => intensity.slice(from * 4, to * 4).reduce((a, b) => a + b, 0) / ((to - from) * 4);
  assert.ok(intensity.length >= 36 * 4 - 1 && intensity.length <= 36 * 4 + 1, "a value for each quarter second");
  assert.ok(intensity.every((value) => value >= 0 && value <= 1));
  assert.ok(mean(14, 22) > mean(2, 10) * 2, "the loud part is well above the quiet one");
  assert.ok(mean(14, 22) > mean(26, 34) * 2);
});

test("the parts of a song are found where its character changes", () => {
  const seconds = 42;
  const samples = new Float32Array(seconds * rate);
  const noise = noiseSource(11);
  const drums = drumTrack(seconds, 120).samples;
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / rate;
    // 0-14 s: a soft low pad; 14-28 s: drums and a bright buzzing lead; 28-42 s: the soft pad again
    const pad = 0.12 * (Math.sin(TAU * 110 * t) + Math.sin(TAU * 165 * t));
    const busy = t >= 14 && t < 28;
    const lead = busy ? 0.18 * (((880 * t) % 1) * 2 - 1) + 0.1 * noise() : 0;
    samples[i] = pad + (busy ? drums[i] : 0) + lead;
  }
  const { sections } = analyse(samples);
  assert.ok(sections.length >= 3 && sections.length <= 4, `${sections.length} parts: ${sections.map((s) => `${s.start.toFixed(0)}-${s.end.toFixed(0)}`).join(", ")}`);
  const cuts = sections.slice(1).map((section) => section.start);
  assert.ok(cuts.some((cut) => Math.abs(cut - 14) <= 2.5), `a change near 14 s in ${cuts.join(", ")}`);
  assert.ok(cuts.some((cut) => Math.abs(cut - 28) <= 2.5), `a change near 28 s in ${cuts.join(", ")}`);
  // The parts tile the song with no gap and no overlap, and the busy one is the loud one.
  assert.equal(sections[0].start, 0);
  assert.ok(Math.abs(sections[sections.length - 1].end - seconds) < 0.01);
  for (let i = 1; i < sections.length; i += 1) assert.equal(sections[i].start, sections[i - 1].end);
  const busy = sections.find((section) => section.start >= 12 && section.end <= 30) ?? sections[1];
  assert.ok(busy.energy > sections[0].energy, "the busy part is louder");
});

test("a short clip is one part, and an empty one does not fail", () => {
  const short = analyse(drumTrack(8, 120).samples);
  assert.equal(short.sections.length, 1);
  assert.equal(short.sections[0].start, 0);
  const empty = analyse(new Float32Array(0));
  assert.equal(empty.duration, 0);
  assert.deepEqual(empty.beats, []);
  assert.equal(empty.bpm, null);
});

// ---------------------------------------------------------------- the visualizer's numbers

test("the bars rise where the sound is, whatever the volume, and the glow flashes on a beat", () => {
  const sine = (hz: number, amplitude: number, seconds: number) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amplitude * Math.sin((TAU * hz * i) / rate));
  const loud = visualTrack(sine(1000, 0.5, 4), rate, 30, []);
  const quiet = visualTrack(sine(1000, 0.04, 4), rate, 30, []);
  assert.equal(loud.frames, 120);
  assert.equal(loud.levels.length, 120 * 64);
  assert.equal(loud.light.length, 120);
  const last = (track: typeof loud) => Array.from(track.levels.slice(110 * 64, 111 * 64));
  const peakBand = (bars: number[]) => bars.indexOf(Math.max(...bars));
  // 1 kHz sits at 64 * log(1000/45) / log(10500/45) of the way along the bands
  const expected = Math.round(64 * (Math.log(1000 / 45) / Math.log(10500 / 45)));
  assert.ok(Math.abs(peakBand(last(loud)) - expected) <= 2, `peak at band ${peakBand(last(loud))}, expected near ${expected}`);
  assert.ok(Math.abs(peakBand(last(quiet)) - expected) <= 2);
  assert.ok(Math.max(...last(loud)) > 200, "full height for a loud tone");
  assert.ok(Math.max(...last(quiet)) > 0.7 * Math.max(...last(loud)), "and nearly so for one twelve times quieter: automatic gain");
  assert.ok(last(loud)[(expected + 20) % 64] < 80, "far from the tone the bars stay low");

  const beats = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
  const track = visualTrack(sine(200, 0.4, 4), rate, 30, beats);
  const afterBeat = track.light[Math.round(2.0 * 30) + 1];
  const justBefore = track.light[Math.round(2.5 * 30) - 1];
  assert.ok(afterBeat > justBefore + 40, `the glow flashes on the beat (${afterBeat}) and fades by the next (${justBefore})`);
});

test("silence draws nothing", () => {
  const track = visualTrack(new Float32Array(rate * 2), rate, 30, []);
  assert.ok(Array.from(track.light).every((value) => value === 0));
  assert.ok(Math.max(...track.levels) < 40, "no bar stands up for silence");
});
