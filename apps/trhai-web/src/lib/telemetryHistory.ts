import type { SparklinePoint } from "../components/Sparkline";

// The recent history behind each reading on the strip.
//
// The rule this exists to keep: a sample that could not be taken is recorded as
// a hole, never skipped and never carried over from the last good read. Skipping
// it draws a straight line across a period when nothing was measured, which is
// the one invented thing on an otherwise measured screen; carrying the last
// value over is worse, because it looks like a machine sitting at a steady
// number when in fact nobody was asking.

export type Series = {
  cpu: SparklinePoint[];
  memory: SparklinePoint[];
  gpu: SparklinePoint[];
  /**
   * Network is throughput, not a fraction, so it is kept as raw bytes/second
   * and normalised against the window's own peak at render. A hole is still a
   * hole: null where the read failed.
   */
  network: SparklinePoint[];
};

/** What a poll produced, or null when the read failed entirely. */
export type Sample = {
  cpu: { fraction: number | null };
  memory: { fraction: number | null };
  gpu: { fraction: number | null };
  network?: { receivedBytesPerSecond: number | null; sentBytesPerSecond: number | null };
} | null;

export const emptySeries = (): Series => ({ cpu: [], memory: [], gpu: [], network: [] });

export function pushSample(prior: Series, sample: Sample, limit: number): Series {
  const push = (series: SparklinePoint[], value: number | null) =>
    [...series, value].slice(-limit);

  const net = sample?.network;
  const throughput = net && (net.receivedBytesPerSecond !== null || net.sentBytesPerSecond !== null)
    ? (net.receivedBytesPerSecond ?? 0) + (net.sentBytesPerSecond ?? 0)
    : null;

  return {
    cpu: push(prior.cpu, sample?.cpu.fraction ?? null),
    memory: push(prior.memory, sample?.memory.fraction ?? null),
    gpu: push(prior.gpu, sample?.gpu.fraction ?? null),
    network: push(prior.network, throughput)
  };
}

/**
 * A raw series normalised against its own peak, for a Sparkline that clamps to
 * 0..1. The shape is real - it is the activity relative to the busiest sample
 * in view - while the absolute scale, which has no natural ceiling, is not
 * claimed. Holes stay holes.
 */
export function normalisedToPeak(series: SparklinePoint[]): SparklinePoint[] {
  const peak = series.reduce<number>((max, value) => (value !== null && value > max ? value : max), 0);
  if (peak <= 0) return series.map((value) => (value === null ? null : 0));
  return series.map((value) => (value === null ? null : value / peak));
}
