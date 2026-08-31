"use client";

import { useId, type CSSProperties } from "react";
import "./core.css";

// The core: TRHAI's own living centre.
//
// It carries nothing a person could mistake for a measurement — no numbers,
// no percentages — and it only moves for a true reason: reachable, thinking,
// executing, speaking, offline. A HUD that visibly "does something" for no
// reason is decoration; one whose motion tracks real state is an instrument,
// and that distinction is the entire point of building this rather than a
// static mockup of it.
//
// "executing" specifically means a tool is actually running right now — see
// useAssistant.ts, which polls the real /v1/assist/activity endpoint for
// this rather than guessing from a timer.
//
// "listening" means a real microphone is genuinely open — see
// useMicrophone.ts — and the `amplitude` prop below carries that device's
// actual loudness, so the core moves with the room rather than to a canned
// rhythm. This state was deliberately absent until the capture existed:
// a core captioned "listening" with nothing behind it is the decoration
// this component was written to refuse.

// The states are the work, not a mood board.
//
// "searching", "reading", "writing" and "analysing" exist because the
// orchestrator genuinely reports which tool is mid-call, so the core can show
// which kind of work is happening rather than one undifferentiated "busy".
// Each one is entered by a real tool invocation and left when that call
// returns. None of them can be reached by a timer.
export type CoreState =
  | "idle" | "listening" | "thinking"
  | "searching" | "reading" | "writing" | "analysing" | "executing"
  | "speaking" | "success" | "error" | "offline";


/**
 * Rounded to 3 decimals — plenty of precision for a 240-unit viewBox, and
 * enough to collapse a real bug: Math.cos/Math.sin are only required by spec
 * to be "implementation-approximated", so Node's V8 (server) and the
 * browser's V8 (client) can legitimately disagree in the last couple of
 * digits for the same input. Full-precision output made every tick a
 * hydration mismatch; this makes server and client agree exactly.
 */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function ticks(count: number, radius: number, length: number) {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      key: index,
      x1: round(120 + cos * radius),
      y1: round(120 + sin * radius),
      x2: round(120 + cos * (radius + length)),
      y2: round(120 + sin * (radius + length)),
      major: index % 5 === 0
    };
  });
}

const outerTicks = ticks(64, 106, 6);
const innerTicks = ticks(40, 62, 4);

/**
 * An arc segment as a dash pattern on a full circle: `on` units drawn, the
 * rest of the circumference skipped, rotated into place. Cheaper than a path
 * and it animates on the GPU as a plain rotation.
 */
function arc(radius: number, on: number) {
  const circumference = 2 * Math.PI * radius;
  return { strokeDasharray: `${round(on)} ${round(circumference - on)}` };
}

/** Small blips riding a ring — the "data moving around the core" of the spec. */
const orbiters = [
  { r: 86, delay: "0s", dur: "7s" },
  { r: 86, delay: "-2.4s", dur: "7s" },
  { r: 100, delay: "-1.1s", dur: "11s" },
  { r: 70, delay: "-3.5s", dur: "9s" }
];

/**
 * Six angular brackets standing off the outer ring.
 *
 * This is TRHAI's own mark, and it is deliberately hexagonal rather than a
 * ring or a segmented disc: circular HUDs are a genre convention anyone may
 * use, but the recognisable arc-reactor silhouette is somebody's protected
 * iconography and is not ours to borrow. A six-point bracket frame reads as
 * this product rather than as a costume of another one.
 */
const brackets = Array.from({ length: 6 }, (_, index) => {
  const angle = (index / 6) * Math.PI * 2 - Math.PI / 2;
  return {
    key: index,
    x: round(120 + Math.cos(angle) * 112),
    y: round(120 + Math.sin(angle) * 112),
    rotate: round((index / 6) * 360)
  };
});

export function Core({ state = "idle", size = 300, amplitude }: {
  state?: CoreState;
  size?: number;
  /**
   * A real loudness reading, 0..1 — the microphone's own level while
   * listening (useMicrophone.ts), or the neural voice's while speaking.
   * Undefined when no reading exists, which is what makes the canned
   * breathing the fallback rather than the default.
   */
  amplitude?: number;
}) {
  const instance = useId().replace(/:/g, "");
  const bloomId = `core-bloom-${instance}`;
  const coreId = `core-body-${instance}`;

  const style: CSSProperties & Record<"--amp", number | undefined> = {
    width: size,
    height: size,
    "--amp": amplitude
  };

  return (
    <div className={`trhai-core core-${state}${amplitude !== undefined ? " core-metered" : ""}`} style={style} aria-hidden="true">
      <svg viewBox="0 0 240 240" className="core-svg">
        <defs>
          <radialGradient id={bloomId}>
            <stop offset="0%" stopColor="var(--accent-strong)" stopOpacity="0.55" />
            <stop offset="55%" stopColor="var(--accent)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={coreId}>
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="40%" stopColor="var(--accent-strong)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.15" />
          </radialGradient>
        </defs>

        <circle cx="120" cy="120" r="112" fill={`url(#${bloomId})`} className="core-bloom" />

        {/* TRHAI's own frame: six angular brackets standing off the rings,
            counter-rotating slowly against them. */}
        <g className="bracket-spin">
          {brackets.map((bracket) => (
            <path
              key={bracket.key}
              d="M -9 -3 L -9 3 M -9 0 L 9 0 M 9 -3 L 9 3"
              className="bracket"
              transform={`translate(${bracket.x} ${bracket.y}) rotate(${bracket.rotate})`}
            />
          ))}
        </g>

        <g className="core-ticks">
          {outerTicks.map((tick) => (
            <line key={tick.key} x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2}
              className={tick.major ? "tick tick-major" : "tick"} />
          ))}
        </g>

        <circle cx="120" cy="120" r="100" className="ring ring-hairline" />
        <circle cx="120" cy="120" r="86" className="ring ring-outer" />

        {/* Heavy arc segments riding their own rings, counter-rotating — the
            layered depth the reference HUD gets from many concentric parts
            rather than one or two plain circles. */}
        <g className="arc-spin arc-spin-a">
          <circle cx="120" cy="120" r="96" className="ring ring-arc" style={arc(96, 120)} />
        </g>
        <g className="arc-spin arc-spin-b">
          <circle cx="120" cy="120" r="96" className="ring ring-arc ring-arc-thin" style={arc(96, 44)} />
        </g>
        <g className="arc-spin arc-spin-c">
          <circle cx="120" cy="120" r="78" className="ring ring-arc ring-arc-bright" style={arc(78, 92)} />
        </g>

        <g className="ring-mid-spin">
          <circle cx="120" cy="120" r="70" className="ring ring-mid" />
        </g>

        <g className="core-sweep">
          <path d="M120 120 L120 26 A94 94 0 0 1 186 54 Z" className="sweep-fill" />
        </g>

        <g className="core-ticks core-ticks-inner">
          {innerTicks.map((tick) => (
            <line key={tick.key} x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2}
              className={tick.major ? "tick tick-major" : "tick"} />
          ))}
        </g>

        <circle cx="120" cy="120" r="52" className="ring ring-inner" />
        <circle cx="120" cy="120" r="42" className="ring ring-inner-2" style={arc(42, 150)} />

        {/* Blips travelling the rings. Each is one element on a rotating
            group — no per-particle JS, so this costs a compositor transform
            and nothing else. */}
        {orbiters.map((orbit, index) => (
          <g key={index} className="orbiter-spin" style={{ animationDelay: orbit.delay, animationDuration: orbit.dur }}>
            <circle cx="120" cy={120 - orbit.r} r="2.4" className="orbiter" />
          </g>
        ))}

        {/* The living centre: a soft, breathing orb rather than a chevron or
            letter — TRHAI has no fixed mark yet, and an abstract core reads
            honestly as "the AI", not as a logo standing in for one. */}
        <circle cx="120" cy="120" r="30" fill={`url(#${coreId})`} className="core-orb" />
        <circle cx="120" cy="120" r="30" className="core-orb-ring" />
      </svg>
    </div>
  );
}
