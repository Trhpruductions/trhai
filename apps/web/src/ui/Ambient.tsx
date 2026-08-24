import type { CSSProperties } from "react";
import "./ambient.css";

// Atmosphere behind the home screen.
//
// Pure ornament, same standing as the core's radar sweep: it measures nothing
// and carries no data, so unlike the stat rail or the link trace it is never
// mistakable for a reading. What keeps it from being decoration for its own
// sake is that it answers to the same state the core does — a touch quicker
// and brighter while the app is actually working, still while it is not —
// rather than drifting on a clock of its own that has nothing to do with what
// the app is doing.
//
// Fixed positions rather than randomised: this project does not use
// Math.random anywhere, and a re-render must not reshuffle the sky.

type Mote = { left: number; top: number; size: number; delay: number; duration: number };

const motes: Mote[] = [
  { left: 12, top: 18, size: 180, delay: 0, duration: 22 },
  { left: 82, top: 12, size: 140, delay: 3, duration: 26 },
  { left: 6, top: 68, size: 160, delay: 6, duration: 24 },
  { left: 90, top: 62, size: 120, delay: 2, duration: 20 },
  { left: 34, top: 86, size: 150, delay: 8, duration: 28 },
  { left: 64, top: 90, size: 130, delay: 5, duration: 23 },
  { left: 50, top: 6, size: 110, delay: 9, duration: 21 }
];

export function Ambient({ busy = false }: { busy?: boolean }) {
  return (
    <div className={`ambient${busy ? " ambient-active" : ""}`} aria-hidden="true">
      {motes.map((mote) => {
        // A custom property, not `animationDuration` directly: the busy state
        // changes speed via a stylesheet rule using calc() on this value, and
        // a plain inline duration would always outrank that rule and the
        // change would never actually show.
        const style: CSSProperties & Record<"--mote-duration", string> = {
          left: `${mote.left}%`,
          top: `${mote.top}%`,
          width: mote.size,
          height: mote.size,
          animationDelay: `${mote.delay}s`,
          "--mote-duration": `${mote.duration}s`
        };

        return <span key={`${mote.left}-${mote.top}`} className="ambient-mote" style={style} />;
      })}
    </div>
  );
}
