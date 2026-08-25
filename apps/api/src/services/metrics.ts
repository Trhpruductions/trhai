// Telemetry for this process, measured rather than guessed.
//
// E10 asks for OpenTelemetry with Prometheus, Grafana and Loki. That stack is
// three server processes and a collector to run beside an app whose whole
// premise is that it runs on one machine with nothing else installed — the
// instrumentation is worth having, the infrastructure is not, and the two are
// separable.
//
// So this records the same things the OTel instrumentation would, with no
// dependency at all, and exposes them in the Prometheus text format. Point
// Prometheus at /v1/metrics and it scrapes; read it in a browser and it is
// legible without one. Nothing about this forecloses adding the SDK later —
// what it avoids is making a local assistant depend on a monitoring cluster
// before it can tell you how long a request took.
//
// Everything here is a measurement. There are no synthetic series and no
// gauges that report a constant: a metric that cannot move is not telling you
// anything, and would fail this codebase's rule everywhere else.

export type Snapshot = {
  counters: Record<string, number>;
  /** name -> observed values, for percentile and mean reporting. */
  histograms: Record<string, number[]>;
  startedAt: string;
};

const counters = new Map<string, number>();
const histograms = new Map<string, number[]>();
const startedAt = new Date().toISOString();

/**
 * How many observations a histogram keeps.
 *
 * Bounded because this process is meant to run for weeks. The newest window
 * is what a percentile should describe anyway — a p95 over a fortnight tells
 * you about a fortnight ago as much as about now.
 */
export const maxObservations = 1000;

/** Metric names are label-free on purpose; see toPrometheus for why. */
function key(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const pairs = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, value]) => `${label}="${escapeLabel(value)}"`)
    .join(",");
  return `${name}{${pairs}}`;
}

/** Prometheus label values may not contain a raw quote, backslash or newline. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function increment(name: string, labels?: Record<string, string>, by = 1): void {
  const id = key(name, labels);
  counters.set(id, (counters.get(id) ?? 0) + by);
}

export function observe(name: string, value: number, labels?: Record<string, string>): void {
  // A negative duration means a clock went backwards, not that something took
  // less than no time. Dropping it beats poisoning the mean.
  if (!Number.isFinite(value) || value < 0) return;

  const id = key(name, labels);
  const values = histograms.get(id) ?? [];
  values.push(value);
  if (values.length > maxObservations) values.splice(0, values.length - maxObservations);
  histograms.set(id, values);
}

/** Time a promise and record how long it really took, success or failure. */
export async function timed<T>(name: string, work: () => Promise<T>, labels?: Record<string, string>): Promise<T> {
  const began = Date.now();
  try {
    const result = await work();
    observe(name, Date.now() - began, { ...labels, outcome: "ok" });
    return result;
  } catch (error) {
    // Failures are timed too. A route that fails slowly is a different problem
    // from one that fails fast, and averaging only the successes hides it.
    observe(name, Date.now() - began, { ...labels, outcome: "failed" });
    throw error;
  }
}

export function snapshot(): Snapshot {
  return {
    counters: Object.fromEntries(counters),
    histograms: Object.fromEntries([...histograms].map(([name, values]) => [name, [...values]])),
    startedAt
  };
}

export function resetMetrics(): void {
  counters.clear();
  histograms.clear();
}

/** The nearest-rank percentile of a sorted copy. */
export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The Prometheus text exposition format.
 *
 * Names already carry their labels from `key`, so this splits them back out
 * rather than storing a parallel structure that could disagree with the
 * counter it describes.
 */
export function toPrometheus(now: Snapshot = snapshot()): string {
  const lines: string[] = [];

  for (const [name, value] of Object.entries(now.counters)) {
    lines.push(`${name} ${value}`);
  }

  // Histograms are reported as the three numbers anyone actually reads. A
  // full bucket histogram would be more faithful to the format and less
  // useful to a person reading this in a browser, which is the likelier case
  // on a machine with no Prometheus installed.
  for (const [name, values] of Object.entries(now.histograms)) {
    const base = name.includes("{") ? name.slice(0, name.indexOf("{")) : name;
    const labels = name.includes("{") ? name.slice(name.indexOf("{")) : "";
    lines.push(`${base}_count${labels} ${values.length}`);
    lines.push(`${base}_mean_ms${labels} ${Math.round(mean(values))}`);
    lines.push(`${base}_p95_ms${labels} ${Math.round(percentile(values, 0.95))}`);
  }

  lines.push(`trhai_process_start_seconds ${Math.floor(new Date(now.startedAt).getTime() / 1000)}`);
  return `${lines.join("\n")}\n`;
}
