// The maths behind the core's reaction to real speech, kept out of the
// component and the hook so it can be tested without an AudioContext.
//
// The core has one rule since it was built: it carries nothing a person could
// mistake for a measurement, and it only moves for a true reason — reachable,
// thinking, offline. Amplitude extends that rule rather than bending it. It is
// read from the actual audio the neural voice is producing, not synthesized to
// look lively, and when there is no real signal to read — the browser's own
// voices give no access to their waveform — nothing here invents one.

/**
 * Loudness of one frame of time-domain audio, as 0..1.
 *
 * `samples` are unsigned bytes centred on 128 (silence), the shape
 * `AnalyserNode.getByteTimeDomainData` fills. This is RMS energy, not peak —
 * peak reacts to a single spike and reads as flicker; RMS moves with the
 * actual loudness of what is being said.
 */
export function rmsAmplitude(samples: Uint8Array): number {
  if (samples.length === 0) return 0;

  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const centered = (samples[index] - 128) / 128;
    sumSquares += centered * centered;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  // Speech rarely drives this near 1 even at its loudest, so a modest gain
  // makes ordinary speech visible instead of the core barely moving at all.
  const gained = rms * 3.2;
  return Math.min(1, Math.max(0, gained));
}

/**
 * One step of exponential smoothing toward `next`.
 *
 * Raw per-frame amplitude is noisy enough to read as a flicker rather than a
 * pulse. `factor` is how much of the new reading to take on this step — low
 * values trail behind real audio and feel laggy, high values barely smooth
 * anything, so this is clamped to a band that stays responsive without
 * jittering.
 */
export function smoothAmplitude(previous: number, next: number, factor = 0.35): number {
  const safeFactor = Math.min(0.8, Math.max(0.05, factor));
  return previous + (next - previous) * safeFactor;
}
