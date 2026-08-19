// The maths behind the link trace, kept out of the component so it can be
// tested without a React tree.

/** Enough to show a trend, few enough to stay legible at this size. */
export const maxBars = 20;

/**
 * The tallest bar, in milliseconds.
 *
 * Fixed rather than scaled to the highest reading. A relative scale makes
 * every strip look the same — 9ms and 900ms would both fill the height, and
 * the shape would carry no information. At 200ms a healthy local round trip
 * sits low and a stall is unmistakable.
 */
export const ceilingMs = 200;

/** The floor, so the fastest reading is still visibly a bar. */
const minimumPercent = 8;

export type Sample = { id: number; ms: number | null };

/**
 * How tall to draw one reading.
 *
 * A failed check is full height rather than absent: nothing happening and
 * nothing answering both look like empty space, and they are not the same.
 */
export function barHeightPercent(ms: number | null): number {
  if (ms === null) return 100;
  return Math.max(minimumPercent, Math.min(100, (ms / ceilingMs) * 100));
}

/** The most recent samples, newest last. Never padded. */
export function trimSamples(samples: Sample[]): Sample[] {
  return samples.slice(-maxBars);
}
