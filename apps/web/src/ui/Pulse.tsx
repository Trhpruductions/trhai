import { useEffect, useRef, useState } from "react";
import { barHeightPercent, trimSamples, type Sample } from "../pulseTrace";
import "./pulse.css";

// The link trace.
//
// A strip of bars, one per completed poll, each as tall as that round trip
// took. It is the one thing on the home screen that accumulates: the rings
// turn on a loop and say only "running", while this is a record of the last
// twenty times the app actually spoke to its own service.
//
// Every bar is a measurement. There is no filler and no synthetic baseline —
// an app that has just opened shows one bar, because one round trip is all
// that has happened. A strip pre-filled with plausible history would look
// identical on a machine where nothing is working.

export function Pulse({ latest, sampleId, online }: {
  /** The most recent round trip, or null when the service did not answer. */
  latest: number | null;
  /** Changes once per completed poll, so a repeat of the same time still registers. */
  sampleId: number;
  online: boolean | null;
}) {
  const [bars, setBars] = useState<Sample[]>([]);
  const lastSample = useRef(-1);

  useEffect(() => {
    // Keyed on the sample rather than the value: two polls that both take 7ms
    // are two events, and the strip should show both.
    if (sampleId === lastSample.current) return;
    lastSample.current = sampleId;

    setBars((current) => trimSamples([...current, { id: sampleId, ms: latest }]));
  }, [sampleId, latest]);

  if (bars.length === 0) return null;

  return (
    <div className={`pulse${online === false ? " pulse-offline" : ""}`}
      aria-label={`Link history, last ${bars.length} checks`}>
      {bars.map((bar) => (
        <span
          key={bar.id}
          className={`pulse-bar${bar.ms === null ? " pulse-miss" : ""}`}
          // A failed check is drawn full height in the warning colour rather
          // than as a gap: nothing happening and nothing answering look the
          // same as empty space, and they are not the same thing.
          style={{ height: `${barHeightPercent(bar.ms)}%` }}
        />
      ))}
    </div>
  );
}
