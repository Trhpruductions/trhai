// What a song does over time, worked out from its samples: where the beats
// are, how loud it is, where it changes, and the spectrum bars a visualizer
// draws. Pure functions on mono samples; musicVideo.ts decodes the file.
//
// Beat tracking follows Ellis (2007): an onset-strength curve from the
// spectrogram, a tempo from its autocorrelation, then a dynamic-programming
// pass that picks the beats that land on strong onsets while staying close to
// that tempo. It is good at steady pop, rock and electronic music and is
// honest when there is no steady beat: it returns none rather than invent one.

export const analysisRate = 22_050;

export type Section = {
  start: number;
  end: number;
  /** Mean loudness of the section, 0 to 1. */
  energy: number;
  kind: "intro" | "outro" | "low" | "high";
};

export type Analysis = {
  duration: number;
  bpm: number | null;
  /** Seconds of each beat, in order. Empty when no steady beat was found. */
  beats: number[];
  /** Loudness for each quarter second, 0 to 1. */
  intensity: number[];
  sections: Section[];
};

// ---------------------------------------------------------------- FFT

/** An in-place radix-2 FFT of a fixed power-of-two size. */
function makeFft(size: number): (re: Float64Array, im: Float64Array) => void {
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i += 1) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = -Math.sin((2 * Math.PI * i) / size);
  }
  const bits = Math.log2(size);
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i += 1) {
    let r = 0;
    for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b);
    reverse[i] = r;
  }
  return (re, im) => {
    for (let i = 0; i < size; i += 1) {
      const j = reverse[i];
      if (j > i) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let width = 2; width <= size; width <<= 1) {
      const half = width >> 1;
      const step = size / width;
      for (let start = 0; start < size; start += width) {
        for (let k = 0, t = 0; k < half; k += 1, t += step) {
          const a = start + k;
          const b = a + half;
          const tr = re[b] * cos[t] - im[b] * sin[t];
          const ti = re[b] * sin[t] + im[b] * cos[t];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };
}

const hann = (size: number) => Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));

// ---------------------------------------------------------------- spectrogram

const melOf = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const hzOf = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

export type Spectrogram = {
  data: Float32Array;
  frames: number;
  bands: number;
  hopSeconds: number;
  /** How many of the lowest bands lie below 250 Hz: where a kick drum is. */
  lowBands: number;
};

/** Log mel-band energy for each hop, centred on that moment. */
export function melSpectrogram(samples: Float32Array, rate: number, size = 1024, hop = 512, bands = 40): Spectrogram {
  const fft = makeFft(size);
  const window = hann(size);
  const frames = Math.max(1, Math.floor(samples.length / hop) + 1);
  const top = Math.min(8_000, rate / 2);
  const edgeBins = Array.from({ length: bands + 2 }, (_, i) => (hzOf(melOf(40) + ((melOf(top) - melOf(40)) * i) / (bands + 1)) * size) / rate);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const data = new Float32Array(frames * bands);
  const floor = Math.log(1e-8);
  for (let f = 0; f < frames; f += 1) {
    const from = f * hop - size / 2;
    for (let i = 0; i < size; i += 1) {
      const s = from + i;
      re[i] = s >= 0 && s < samples.length ? samples[s] * window[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bands; b += 1) {
      const lo = edgeBins[b];
      const mid = edgeBins[b + 1];
      const hi = edgeBins[b + 2];
      let energy = 0;
      for (let bin = Math.max(1, Math.floor(lo)); bin <= Math.min(size / 2 - 1, Math.ceil(hi)); bin += 1) {
        const weight = bin < mid ? (bin - lo) / (mid - lo) : (hi - bin) / (hi - mid);
        if (weight > 0) energy += weight * (re[bin] * re[bin] + im[bin] * im[bin]);
      }
      data[f * bands + b] = Math.max(floor, Math.log(energy + 1e-10));
    }
  }
  // The centre of band b is edge b+1; count the bands whose centre is under 250 Hz.
  const lowBands = Array.from({ length: bands }, (_, b) => (edgeBins[b + 1] * rate) / size).filter((hz) => hz < 250).length;
  return { data, frames, bands, hopSeconds: hop / rate, lowBands };
}

// ---------------------------------------------------------------- onsets, tempo, beats

/** A rise-only flux per frame, minus what is usual in the half second around it, on its own scale; zeros when nothing changes at all. */
function normalisedOnsets(flux: Float32Array, hopSeconds: number): Float32Array {
  const radius = Math.max(2, Math.round(0.4 / hopSeconds));
  const onset = new Float32Array(flux.length);
  let running = 0;
  let count = 0;
  for (let f = 0; f < Math.min(flux.length, radius); f += 1) { running += flux[f]; count += 1; }
  let squares = 0;
  for (let f = 0; f < flux.length; f += 1) {
    const add = f + radius;
    const drop = f - radius - 1;
    if (add < flux.length) { running += flux[add]; count += 1; }
    if (drop >= 0) { running -= flux[drop]; count -= 1; }
    onset[f] = Math.max(0, flux[f] - running / count);
    squares += onset[f] * onset[f];
  }
  const spread = Math.sqrt(squares / flux.length);
  // Below this the "changes" are rounding noise (a held note): scaling them up would turn them into a rhythm.
  if (spread < 0.005) return new Float32Array(flux.length);
  for (let f = 0; f < flux.length; f += 1) onset[f] /= spread;
  return onset;
}

/**
 * How sharply the sound changes, frame by frame.
 *
 * Two curves, added: rises in every band, and rises in the low end alone. A
 * drum kit's off-beat hats are as sharp as its kicks, and the beat is the kick;
 * counting the low end twice puts the beat there. With no kick the low curve is
 * flat and the whole spectrum decides.
 */
export function onsetStrength(spec: Spectrogram): Float32Array {
  const everything = new Float32Array(spec.frames);
  const lows = new Float32Array(spec.frames);
  for (let f = 1; f < spec.frames; f += 1) {
    let sum = 0;
    let low = 0;
    for (let b = 0; b < spec.bands; b += 1) {
      const rise = spec.data[f * spec.bands + b] - spec.data[(f - 1) * spec.bands + b];
      if (rise > 0) {
        sum += rise;
        if (b < spec.lowBands) low += rise;
      }
    }
    everything[f] = sum / spec.bands;
    lows[f] = low / Math.max(1, spec.lowBands);
  }
  const all = normalisedOnsets(everything, spec.hopSeconds);
  const bass = normalisedOnsets(lows, spec.hopSeconds);
  const onset = new Float32Array(spec.frames);
  for (let f = 0; f < spec.frames; f += 1) onset[f] = all[f] + 1.2 * bass[f];
  return onset;
}

/**
 * The beat period in frames, from the autocorrelation of the onsets, and how
 * far that rhythm stands out from the rest (a ratio: noise is near 1, a steady
 * groove several times that). Null when there is no rhythm at all.
 */
export function beatPeriod(onset: Float32Array, hopSeconds: number): { period: number; strength: number } | null {
  const n = onset.length;
  const minLag = Math.max(2, Math.floor(60 / (200 * hopSeconds)));
  const maxLag = Math.ceil(60 / (60 * hopSeconds));
  if (n < maxLag * 4) return null;
  // A few frames of smoothing: the true period is rarely a whole number of frames, and an onset a
  // fraction of a frame out of step should still count as being in step.
  const smooth = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    smooth[i] = (onset[Math.max(0, i - 2)] + 2 * onset[Math.max(0, i - 1)] + 3 * onset[i] + 2 * onset[Math.min(n - 1, i + 1)] + onset[Math.min(n - 1, i + 2)]) / 9;
  }
  let energy = 0;
  for (let i = 0; i < n; i += 1) energy += smooth[i] * smooth[i];
  if (energy < 1e-6) return null;
  const autocorrelation = new Float64Array(maxLag * 4 + 2);
  for (let lag = 1; lag < autocorrelation.length; lag += 1) {
    let sum = 0;
    for (let t = 0; t + lag < n; t += 1) sum += smooth[t] * smooth[t + lag];
    autocorrelation[lag] = sum / (n - lag);
  }
  const strengthOf = new Float64Array(maxLag + 2);
  const scores = new Float64Array(maxLag + 2);
  let best = -Infinity;
  let bestLag = 0;
  let total = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    // The rhythm at this period also shows at twice, three and four times it; a longer period that is
    // only a multiple of the real one scores only at its own multiples, which is what tells them apart.
    const comb = autocorrelation[lag] + 0.8 * autocorrelation[lag * 2] + 0.6 * autocorrelation[lag * 3] + 0.4 * autocorrelation[lag * 4];
    strengthOf[lag] = comb;
    total += comb;
    // Prefer tempos near 120 without forbidding the others.
    const bpm = 60 / (lag * hopSeconds);
    scores[lag] = comb * Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.1) ** 2);
    if (scores[lag] > best) { best = scores[lag]; bestLag = lag; }
  }
  if (bestLag === 0 || best <= 0) return null;
  const mean = total / (maxLag - minLag + 1);
  // Parabolic refinement around the peak, so that the period is not rounded to a whole frame.
  const left = scores[bestLag - 1] ?? scores[bestLag];
  const right = scores[bestLag + 1] ?? scores[bestLag];
  const curve = left - 2 * scores[bestLag] + right;
  const shift = curve < 0 ? (0.5 * (left - right)) / curve : 0;
  return { period: bestLag + Math.max(-0.5, Math.min(0.5, shift)), strength: strengthOf[bestLag] / (mean || 1) };
}

/** Beats as frame numbers: the path through the onsets that is strong and keeps the period (Ellis 2007). */
export function trackBeats(onset: Float32Array, period: number, tightness = 80): number[] {
  const n = onset.length;
  const score = new Float64Array(n);
  const previous = new Int32Array(n).fill(-1);
  const lowest = Math.round(period / 2);
  const highest = Math.round(period * 2);
  for (let t = 0; t < n; t += 1) {
    let best = -Infinity;
    let from = -1;
    for (let gap = lowest; gap <= highest; gap += 1) {
      const p = t - gap;
      if (p < 0) break;
      const candidate = score[p] - tightness * Math.log(gap / period) ** 2;
      if (candidate > best) { best = candidate; from = p; }
    }
    score[t] = onset[t] + (from >= 0 ? best : 0);
    previous[t] = from;
  }
  // The last beat is the best-scoring frame among the final period.
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t += 1) if (score[t] > score[end]) end = t;
  const beats: number[] = [];
  for (let t = end; t >= 0; t = previous[t]) {
    beats.push(t);
    if (previous[t] < 0) break;
  }
  return beats.reverse();
}

// ---------------------------------------------------------------- loudness and sections

/** Loudness for each quarter second, 0 to 1, against the loud parts of this song. */
export function loudness(samples: Float32Array, rate: number): number[] {
  const window = Math.round(rate * 0.25);
  const count = Math.max(1, Math.ceil(samples.length / window));
  const rms: number[] = [];
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    const from = i * window;
    const to = Math.min(samples.length, from + window);
    for (let s = from; s < to; s += 1) sum += samples[s] * samples[s];
    rms.push(to > from ? Math.sqrt(sum / (to - from)) : 0);
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)] || 1e-9;
  const scaled = rms.map((value) => Math.min(1, value / loud) ** 0.8);
  // A little smoothing, so that a single quiet beat does not read as a quiet moment.
  return scaled.map((_, i) => ((scaled[i - 1] ?? scaled[i]) + scaled[i] * 2 + (scaled[i + 1] ?? scaled[i])) / 4);
}

/** Where the song changes character: boundaries of the parts, each with its own loudness. */
export function findSections(spec: Spectrogram, intensity: number[], duration: number): Section[] {
  const whole = (start: number, end: number, kind: Section["kind"]): Section => {
    const from = Math.floor(start * 4);
    const to = Math.max(from + 1, Math.ceil(end * 4));
    const slice = intensity.slice(from, to);
    return { start, end, energy: slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0, kind };
  };
  const windows = Math.floor(duration);
  if (windows < 16) return [whole(0, duration, "low")];

  // One feature vector per second: ten mel groups (four bands each) and the loudness.
  const groups = 10;
  const perGroup = spec.bands / groups;
  const features: number[][] = [];
  for (let w = 0; w < windows; w += 1) {
    const from = Math.floor(w / spec.hopSeconds);
    const to = Math.min(spec.frames, Math.floor((w + 1) / spec.hopSeconds));
    const vector = new Array<number>(groups + 1).fill(0);
    for (let f = from; f < to; f += 1) {
      for (let g = 0; g < groups; g += 1) {
        let sum = 0;
        for (let b = 0; b < perGroup; b += 1) sum += spec.data[f * spec.bands + g * perGroup + b];
        vector[g] += sum / perGroup;
      }
    }
    for (let g = 0; g < groups; g += 1) vector[g] /= Math.max(1, to - from);
    const loud = intensity.slice(w * 4, w * 4 + 4);
    vector[groups] = (loud.reduce((a, b) => a + b, 0) / Math.max(1, loud.length)) * 12;
    features.push(vector);
  }
  // Each dimension on its own scale.
  for (let d = 0; d <= groups; d += 1) {
    const mean = features.reduce((a, v) => a + v[d], 0) / windows;
    const spread = Math.sqrt(features.reduce((a, v) => a + (v[d] - mean) ** 2, 0) / windows) || 1;
    for (const v of features) v[d] = (v[d] - mean) / spread;
  }
  // Novelty: how different the next few seconds are from the last few.
  const novelty = new Array<number>(windows).fill(0);
  for (let i = 2; i <= windows - 2; i += 1) {
    const k = Math.min(4, i, windows - i);
    let sum = 0;
    for (let d = 0; d <= groups; d += 1) {
      let before = 0;
      let after = 0;
      for (let j = 1; j <= k; j += 1) { before += features[i - j][d]; after += features[i + j - 1][d]; }
      sum += (after / k - before / k) ** 2;
    }
    novelty[i] = Math.sqrt(sum);
  }
  const mean = novelty.reduce((a, b) => a + b, 0) / windows;
  const spread = Math.sqrt(novelty.reduce((a, b) => a + (b - mean) ** 2, 0) / windows) || 1;
  // Peaks: the strongest first, none within six seconds of one already kept.
  const peaks = novelty
    .map((value, i) => ({ i, value }))
    .filter(({ i, value }) => value > mean + 0.8 * spread && value >= Math.max(...novelty.slice(Math.max(0, i - 3), i + 4)))
    .sort((a, b) => b.value - a.value);
  const kept: number[] = [];
  for (const peak of peaks) if (kept.every((other) => Math.abs(other - peak.i) >= 6) && peak.i >= 5 && duration - peak.i >= 4) kept.push(peak.i);
  const cuts = [0, ...kept.sort((a, b) => a - b), duration];
  const parts: Section[] = [];
  for (let c = 0; c < cuts.length - 1; c += 1) parts.push(whole(cuts[c], cuts[c + 1], "low"));
  // Whatever has no standing of its own joins the part before it.
  for (let p = parts.length - 1; p > 0; p -= 1) {
    if (parts[p].end - parts[p].start < 5) {
      parts[p - 1] = whole(parts[p - 1].start, parts[p].end, "low");
      parts.splice(p, 1);
    }
  }
  const middle = [...parts].map((p) => p.energy).sort((a, b) => a - b)[Math.floor(parts.length / 2)];
  return parts.map((part, index) => {
    if (index === 0 && parts.length > 1 && part.energy < middle * 0.95) return { ...part, kind: "intro" as const };
    if (index === parts.length - 1 && parts.length > 1 && part.energy < middle * 0.95) return { ...part, kind: "outro" as const };
    return { ...part, kind: part.energy >= middle * 1.02 ? ("high" as const) : ("low" as const) };
  });
}

// ---------------------------------------------------------------- the whole analysis

/** Calibrated against a click track: the onset curve peaks a little before the sound is at its loudest. */
const beatLatencySeconds = 0.012;

/** How far the best tempo must stand out from the others for the song to count as having a beat. */
const minRhythmStrength = 1.5;

export function analyse(samples: Float32Array, rate = analysisRate): Analysis {
  const duration = samples.length / rate;
  const spec = melSpectrogram(samples, rate);
  const onset = onsetStrength(spec);
  const intensity = loudness(samples, rate);
  const sections = findSections(spec, intensity, duration);

  const rhythm = beatPeriod(onset, spec.hopSeconds);
  let beats: number[] = [];
  let bpm: number | null = null;
  // Noise has no rhythm: its autocorrelation is flat, so its best period barely stands out from the rest.
  if (rhythm && rhythm.strength >= minRhythmStrength) {
    const frames = trackBeats(onset, rhythm.period);
    const onBeats = frames.reduce((sum, f) => sum + onset[f], 0) / Math.max(1, frames.length);
    const overall = onset.reduce((sum, v) => sum + v, 0) / onset.length;
    // A steady beat also has onsets on the beats that stand well above the rest.
    if (frames.length >= 4 && onBeats > overall * 1.6) {
      beats = frames.map((f) => Math.max(0, f * spec.hopSeconds + beatLatencySeconds));
      bpm = Math.round((60 / (rhythm.period * spec.hopSeconds)) * 10) / 10;
    }
  }
  return { duration, bpm, beats, intensity, sections };
}

// ---------------------------------------------------------------- what the visualizer draws

export type VisualTrack = {
  fps: number;
  frames: number;
  bands: number;
  /** For each frame, the height of each spectrum bar, 0 to 255. */
  levels: Uint8Array;
  /** For each frame, how much the picture glows, 0 to 255: a quiet glow with the loudness and a flash on each beat. */
  light: Uint8Array;
};

/**
 * The spectrum bars and the glow for every video frame.
 *
 * Bars follow the level of each band with automatic gain: the loudest recent
 * band is full height whatever the song's volume, and each bar rises quickly
 * and falls slowly, which is what makes a spectrum look like music rather than
 * like noise. The bands are spaced evenly on a log scale from 45 Hz to 10.5 kHz.
 */
/** Quieter than this is silence: a bar never reads full height from hiss. */
const minimumCeilingDb = -55;

export function visualTrack(samples: Float32Array, rate: number, fps: number, beats: number[], bands = 64): VisualTrack {
  const size = 2048;
  const fft = makeFft(size);
  const window = hann(size);
  const frames = Math.max(1, Math.ceil((samples.length / rate) * fps));
  const top = Math.min(10_500, rate / 2 - 1);
  const edges = Array.from({ length: bands + 1 }, (_, k) => 45 * (top / 45) ** (k / bands));
  const binOf = (hz: number) => Math.min(size / 2 - 1, Math.max(1, Math.round((hz * size) / rate)));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const level = new Float64Array(bands);
  const db = new Float64Array(bands);
  const levels = new Uint8Array(frames * bands);
  const light = new Uint8Array(frames);
  // The reference for "full height": it climbs at once to the first real sound and sinks slowly, never below a whisper.
  let ceiling = minimumCeilingDb;
  let loud = 0;
  let nextBeat = 0;
  let lastBeat = -99;
  for (let f = 0; f < frames; f += 1) {
    const seconds = f / fps;
    const from = Math.round(seconds * rate) - size / 2;
    for (let i = 0; i < size; i += 1) {
      const s = from + i;
      re[i] = s >= 0 && s < samples.length ? samples[s] * window[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    let loudest = -200;
    let power = 0;
    for (let k = 0; k < bands; k += 1) {
      const lo = binOf(edges[k]);
      const hi = Math.max(lo + 1, binOf(edges[k + 1]));
      let sum = 0;
      for (let b = lo; b < hi; b += 1) sum += re[b] * re[b] + im[b] * im[b];
      const magnitude = Math.sqrt(sum / (hi - lo)) / (size / 4);
      // A gentle tilt (+3 dB an octave): music has far more low end than high, and the ring should move all the way round.
      db[k] = 20 * Math.log10(magnitude + 1e-7) + 3 * Math.log2((edges[k] + edges[k + 1]) / 2 / 1000);
      if (db[k] > loudest) loudest = db[k];
      power += magnitude * magnitude;
    }
    ceiling = Math.max(minimumCeilingDb, ceiling + (loudest > ceiling ? 0.5 : 0.004) * (loudest - ceiling));
    const floor = ceiling - 42;
    for (let k = 0; k < bands; k += 1) {
      const v = Math.min(1, Math.max(0, (db[k] - floor) / (ceiling - floor))) ** 1.35;
      level[k] += (v > level[k] ? 0.6 : 0.16) * (v - level[k]);
    }
    for (let k = 0; k < bands; k += 1) {
      // Valleys between tall bars are partly filled in, so the ring is smooth; a lone peak keeps its full height.
      const around = (level[Math.max(0, k - 1)] + level[Math.min(bands - 1, k + 1)]) / 2;
      const smoothed = Math.max(level[k], 0.6 * around);
      levels[f * bands + k] = Math.round(smoothed * 255);
    }
    const rms = Math.sqrt(power / bands);
    loud += (rms > loud ? 0.4 : 0.05) * (rms - loud);
    while (nextBeat < beats.length && beats[nextBeat] <= seconds + 1e-6) { lastBeat = beats[nextBeat]; nextBeat += 1; }
    const pulse = Math.exp(-5.5 * (seconds - lastBeat));
    const energy = Math.min(1, (loud * 9) ** 0.7);
    light[f] = Math.round(Math.min(1, 0.28 * energy + 0.62 * pulse * (0.4 + 0.6 * energy)) * 255);
  }
  return { fps, frames, bands, levels, light };
}
