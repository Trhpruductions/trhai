// A reading's recent history, drawn to the width it is given.
//
// Values are 0..1, oldest first. A null is a sample that could not be taken,
// and stays a gap - joining across it would draw a reading nobody made.

export type TrendTone = "accent" | "violet" | "ok" | "warn" | "danger";

export function Trend({ values, height = 44, tone = "accent", label }: {
  values: Array<number | null>;
  height?: number;
  tone?: TrendTone;
  /** For screen readers: what this is a history of. */
  label?: string;
}) {
  const known = values.filter((value): value is number => value !== null);
  if (known.length < 2 || values.length < 2) {
    return <div className="os-trend os-trend-empty" style={{ height }} aria-hidden="true"><span>Gathering readings…</span></div>;
  }

  const width = 100;
  const pad = 2;
  const usable = height - pad * 2;
  const x = (index: number) => (index / (values.length - 1)) * width;
  const y = (value: number) => pad + (1 - Math.min(1, Math.max(0, value))) * usable;

  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push([x(index), y(value)]);
  });
  if (run.length) runs.push(run);

  const last = runs[runs.length - 1][runs[runs.length - 1].length - 1];
  const latest = known[known.length - 1];
  const id = `trend-${tone}`;

  return (
    <div className={`os-trend ${tone}`} style={{ height }} role="img" aria-label={label ? `${label}: latest ${Math.round(latest * 100)}%` : undefined}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" className="os-trend-stop-top" />
            <stop offset="100%" className="os-trend-stop-bottom" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((line) => (
          <line key={line} className="os-trend-grid" x1="0" x2={width} y1={pad + line * usable} y2={pad + line * usable} vectorEffect="non-scaling-stroke" />
        ))}
        {runs.map((points, index) => {
          const line = points.map(([px, py]) => `${px.toFixed(2)},${py.toFixed(2)}`).join(" ");
          const area = `M${points[0][0].toFixed(2)},${height} L${line.replace(/ /g, " L")} L${points[points.length - 1][0].toFixed(2)},${height} Z`;
          return (
            <g key={index}>
              <path d={area} fill={`url(#${id})`} className="os-trend-area" />
              <polyline points={line} className="os-trend-line" vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </svg>
      <span className="os-trend-tip" style={{ left: `${last[0]}%`, top: last[1] }} aria-hidden="true" />
    </div>
  );
}
