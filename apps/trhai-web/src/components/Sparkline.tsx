"use client";

import "./sparkline.css";

// A reading's recent history, drawn small.
//
// Every number on this screen was a single instant with its past thrown away,
// which is why the top strip looked static between polls: 47%, then 51%, then
// 44%, with nothing to say whether that was a spike, a climb, or noise. The
// trace is the same measurements kept for two minutes, so a glance answers
// "is this going somewhere" as well as "what is it now".
//
// Nothing here is interpolated or smoothed. The line is the samples that were
// actually taken, joined; a gap in the readings is drawn as a gap, because a
// straight line across a period where nothing was measured would be the one
// invented thing on an otherwise measured screen.

export type SparklinePoint = number | null;

export function Sparkline({ values, width = 54, height = 16 }: {
  /** Oldest first. Null where that sample could not be read. */
  values: SparklinePoint[];
  width?: number;
  height?: number;
}) {
  // Two real points are the minimum that can describe a direction.
  const known = values.filter((value): value is number => value !== null);
  if (known.length < 2) return <span className="spark spark-empty" aria-hidden="true" />;

  const step = values.length > 1 ? width / (values.length - 1) : width;
  // Padded a little inside the box so a full-scale reading is not clipped to
  // the border and mistaken for a flat line along the top.
  const top = 1.5;
  const usable = height - top * 2;

  // Runs of consecutive real samples. Each becomes its own polyline, which is
  // what leaves a genuine gap where the machine could not be asked.
  const runs: Array<Array<{ x: number; y: number }>> = [];
  let run: Array<{ x: number; y: number }> = [];

  values.forEach((value, index) => {
    if (value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push({
      x: index * step,
      y: top + (1 - Math.min(1, Math.max(0, value))) * usable
    });
  });
  if (run.length > 0) runs.push(run);

  const latest = known[known.length - 1];
  const tip = runs[runs.length - 1]?.[runs[runs.length - 1].length - 1];

  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      {runs.map((points, index) => (
        <polyline
          key={index}
          className="spark-line"
          points={points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}
        />
      ))}
      {/* A dot on the newest sample, so it is obvious which end is now. */}
      {tip ? <circle className="spark-tip" cx={tip.x} cy={tip.y} r="1.6" /> : null}
      {/* The high-water mark, drawn only when the peak is meaningfully above
          the current reading — otherwise it is a line on top of the trace. */}
      {Math.max(...known) - latest > 0.12 ? (
        <line
          className="spark-peak"
          x1="0" x2={width}
          y1={top + (1 - Math.max(...known)) * usable}
          y2={top + (1 - Math.max(...known)) * usable}
        />
      ) : null}
    </svg>
  );
}
