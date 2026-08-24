// The maths behind a stat rolling from its old value to its new one, kept out
// of the component so it can be tested without a React tree — same reasoning
// as pulseTrace.ts.
//
// The stat rail already refreshed honestly before this: a real poll landed, a
// real number changed, and a glow marked the moment. This adds motion to that
// same true event rather than replacing it — the number is still exactly what
// the last poll read, it just travels there visibly instead of snapping.

const ease = (t: number) => 1 - (1 - t) ** 3;

/**
 * Where the count should read partway through its transition.
 *
 * `elapsedMs` past `durationMs` clamps to `to` — this is called on every
 * animation frame, and a caller that keeps calling after the transition ends
 * must keep landing on the real value, not overshoot or freeze short of it.
 */
export function interpolateCount(from: number, to: number, elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return to;
  if (elapsedMs <= 0) return from;

  const t = ease(elapsedMs / durationMs);
  return Math.round(from + (to - from) * t);
}
