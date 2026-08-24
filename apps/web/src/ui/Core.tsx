import { useId, type CSSProperties } from "react";
import "./core.css";

// The core.
//
// A ring assembly that turns while the app is up and quickens while it is
// thinking. It is ornament, and it is labelled as nothing else: it carries no
// numbers, no percentages and no readouts, so there is nothing on it a person
// could mistake for a measurement. What it does carry is honest — it moves
// when the service is reachable and goes still and grey when it is not, so a
// glance at it tells you the true state of the system.

export type CoreState = "idle" | "thinking" | "speaking" | "offline";

/** Evenly spaced marks around a circle, as line endpoints. */
function ticks(count: number, radius: number, length: number) {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    return {
      key: index,
      x1: 120 + cos * radius,
      y1: 120 + sin * radius,
      x2: 120 + cos * (radius + length),
      y2: 120 + sin * (radius + length),
      // Every fifth mark is longer and brighter, so the ring reads as a scale
      // rather than a texture.
      major: index % 5 === 0
    };
  });
}

const outerTicks = ticks(60, 104, 6);

export function Core({ state = "idle", size = 300, amplitude }: {
  state?: CoreState;
  size?: number;
  /**
   * Real loudness of the neural voice, 0..1, while `state` is "speaking".
   *
   * Undefined — not 0 — is how a caller says "no real reading exists": the
   * browser's own voices expose no waveform, and the core falls back to a
   * fixed animated pulse rather than sitting motionless or, worse, moving to
   * a number that was never a measurement of anything.
   */
  amplitude?: number;
}) {
  // Unique per instance: two cores can be mounted at once, and a duplicated
  // gradient id makes the second one reference the first one's definition.
  const instance = useId().replace(/:/g, "");
  const bloomId = `core-bloom-${instance}`;
  const sweepId = `core-sweep-${instance}`;

  const style: CSSProperties & Record<"--amp", number | undefined> = {
    width: size,
    height: size,
    "--amp": amplitude
  };

  return (
    <div className={`core core-${state}${amplitude !== undefined ? " core-metered" : ""}`}
      style={style} aria-hidden="true">
      <svg viewBox="0 0 240 240" className="core-svg">
        <defs>
          <radialGradient id={bloomId}>
            <stop offset="0%" stopColor="var(--accent-strong)" stopOpacity="0.55" />
            <stop offset="55%" stopColor="var(--accent)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>

          <linearGradient id={sweepId} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        <circle cx="120" cy="120" r="112" fill={`url(#${bloomId})`} className="core-bloom" />

        {/* Fixed scale ring. Stationary so the moving rings have something to
            move against; a HUD where everything turns at once reads as noise. */}
        <g className="core-ticks">
          {outerTicks.map((tick) => (
            <line key={tick.key} x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2}
              className={tick.major ? "tick tick-major" : "tick"} />
          ))}
        </g>

        <circle cx="120" cy="120" r="100" className="ring ring-hairline" />

        {/* Broken outer ring, clockwise. */}
        <circle cx="120" cy="120" r="88" className="ring ring-outer" />

        {/* Three arcs, anticlockwise, so the assembly counter-rotates. */}
        <g className="ring-mid-spin">
          <circle cx="120" cy="120" r="72" className="ring ring-mid" />
        </g>

        <circle cx="120" cy="120" r="56" className="ring ring-inner" />

        {/* Sweep. A wedge that travels round the dial, the way a radar trace
            does. It measures nothing and is drawn as a soft gradient rather
            than a needle, so it reads as the assembly being alive rather than
            as a value being pointed at. */}
        <g className="core-sweep">
          <path d="M120 120 L120 24 A96 96 0 0 1 188 52 Z" fill={`url(#${sweepId})`} />
        </g>

        {/* The pulse. Slow while idle, quick while a reply is being produced —
            this is the part that makes waiting legible without a spinner. */}
        <circle cx="120" cy="120" r="40" className="core-pulse" />

        {/* The mark. A chevron rather than another ring: the rings say the
            machine is running, this says which machine. Drawn as a stroked
            path so it reads at any size and inherits the accent with
            everything else — no image file to go stale against the palette. */}
        <path d="M96 78 L120 122 L144 78" className="core-mark" />
        <path d="M107 78 L120 102 L133 78" className="core-mark core-mark-inner" />
      </svg>
    </div>
  );
}
