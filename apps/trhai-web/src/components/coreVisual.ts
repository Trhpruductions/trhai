import type { CoreState } from "./Core";

// How each core state looks, kept apart from the renderer so it can be tested
// without a GPU.
//
// The core is presence, not an instrument. That distinction is the whole
// reason this file can exist at all: a gauge that moves without a reading
// behind it is a lie, but a core that breathes while idle is not claiming to
// measure anything — it is the app being visibly awake. Every number that
// *does* claim to be a measurement lives in the panels, where an unreadable
// sensor prints "not reported" instead of a plausible value.
//
// What the core still refuses to do is imply work that is not happening. The
// state it renders is set by the orchestrator from the tool genuinely running,
// so "writing" cannot appear unless something is being written, and amplitude
// is the real level from the microphone or the voice.

export type CoreVisual = {
  /** Base colour, linear 0..1 RGB. */
  color: [number, number, number];
  /** Secondary colour, used for filaments and the outer field. */
  accent: [number, number, number];
  /** Overall activity: turbulence, brightness, particle speed. 0..1. */
  energy: number;
  /** Ring rotation multiplier. Negative spins the other way. */
  spin: number;
  /**
   * Where the field goes: positive draws particles inward, negative pushes
   * them out. Searching looks outward because it is going somewhere to look;
   * writing and executing converge because output forms at the centre.
   */
  converge: number;
  /** 0 when the machine cannot be reached, which drains the colour. */
  alive: number;
};

const cyan: [number, number, number] = [0.21, 0.78, 1.0];
const paleCyan: [number, number, number] = [0.62, 0.93, 1.0];
const violet: [number, number, number] = [0.55, 0.45, 1.0];
const teal: [number, number, number] = [0.16, 0.9, 0.82];
const amber: [number, number, number] = [1.0, 0.71, 0.25];
const green: [number, number, number] = [0.29, 0.89, 0.66];
const red: [number, number, number] = [1.0, 0.36, 0.36];
const grey: [number, number, number] = [0.42, 0.48, 0.54];

const visuals: Record<CoreState, CoreVisual> = {
  // Idle is not dead: enough energy to drift and breathe, no convergence.
  idle: { color: cyan, accent: paleCyan, energy: 0.22, spin: 1, converge: 0, alive: 1 },
  // Listening brightens and holds still — attention, not activity. The motion
  // that matters here comes from the real microphone level instead.
  listening: { color: paleCyan, accent: cyan, energy: 0.45, spin: 0.7, converge: -0.15, alive: 1 },
  thinking: { color: violet, accent: cyan, energy: 0.6, spin: 1.6, converge: 0.2, alive: 1 },
  searching: { color: teal, accent: paleCyan, energy: 0.75, spin: 2.1, converge: -0.6, alive: 1 },
  reading: { color: cyan, accent: teal, energy: 0.5, spin: 1.1, converge: 0.3, alive: 1 },
  writing: { color: amber, accent: paleCyan, energy: 0.8, spin: 1.8, converge: 0.65, alive: 1 },
  analysing: { color: violet, accent: teal, energy: 0.7, spin: -1.5, converge: 0.45, alive: 1 },
  // The most energy and the strongest pull: a tool is genuinely running.
  executing: { color: cyan, accent: amber, energy: 1, spin: 2.4, converge: 0.8, alive: 1 },
  speaking: { color: paleCyan, accent: teal, energy: 0.55, spin: 0.9, converge: -0.35, alive: 1 },
  success: { color: green, accent: paleCyan, energy: 0.6, spin: 1.2, converge: -0.7, alive: 1 },
  error: { color: red, accent: amber, energy: 0.3, spin: 0.3, converge: 0, alive: 1 },
  // Unreachable: barely moving, colour drained. It should be obvious at a
  // glance that this is not a working machine.
  offline: { color: grey, accent: grey, energy: 0.06, spin: 0.15, converge: 0, alive: 0 }
};

export function visualForState(state: CoreState): CoreVisual {
  return visuals[state] ?? visuals.idle;
}

/**
 * The breathing level to use when there is no real reading.
 *
 * Three sines whose periods share no common multiple, so the rhythm never
 * repeats exactly — a single sine reads as a loop within about ten seconds,
 * which is what makes an idle animation look mechanical. Returns 0..1.
 */
export function breathe(seconds: number): number {
  const value = 0.55 * Math.sin(seconds * 0.37)
    + 0.30 * Math.sin(seconds * 0.61 + 1.3)
    + 0.15 * Math.sin(seconds * 0.23 + 2.7);
  return Math.min(1, Math.max(0, 0.5 + 0.5 * value));
}

/**
 * Which colour a gauge ring takes.
 *
 * `higherIsBetter` exists because health runs the other way from everything
 * else on the panel. Without it the health ring turned danger-red exactly when
 * every check was passing — a red alarm sitting over the words "all passing",
 * which is worse than an uncoloured ring because it is confidently wrong.
 */
export function gaugeTone(
  fraction: number | null | undefined,
  higherIsBetter = false
): "ok" | "warn" | "danger" | "unknown" {
  if (fraction === null || fraction === undefined) return "unknown";
  const severity = higherIsBetter ? 1 - fraction : fraction;
  if (severity >= 0.9) return "danger";
  if (severity >= 0.7) return "warn";
  return "ok";
}
