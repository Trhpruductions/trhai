"use client";

import "./corehud.css";

// Readings annotated around the core, for the screen with the rails hidden.
//
// Hiding the panels should cost attention, not information. These are the same
// measurements the gauges carry — the GPU's real temperature, real load, real
// uptime, real throughput — placed as HUD annotations in the space the panels
// left behind, with a leader line back toward the thing they describe.
//
// They only appear when the rails are down. With the panels showing, the same
// numbers are already on screen, and putting them in both places would be the
// duplication this screen was cleaned up to remove.
//
// Every one of them can read "—". A HUD annotation is exactly the kind of
// element that looks most convincing when it is lying, so an unavailable
// sensor prints a dash rather than a plausible figure.

export type HudReading = {
  label: string;
  value: string;
  /** Where it sits, as a corner of the stage. */
  at: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** True when this is a real measurement rather than a placeholder. */
  known: boolean;
};

export function CoreHud({ readings }: { readings: HudReading[] }) {
  return (
    <div className="hud" aria-hidden="true">
      {readings.map((reading) => (
        <div key={reading.label} className={`hud-note hud-${reading.at}${reading.known ? "" : " unknown"}`}>
          <span className="hud-note-line" />
          <span className="hud-note-label">{reading.label}</span>
          <span className="hud-note-value">{reading.value}</span>
        </div>
      ))}
    </div>
  );
}
