import type { SparklinePoint } from "../components/Sparkline";

// The recent history behind each reading on the strip.
//
// The rule this exists to keep: a sample that could not be taken is recorded as
// a hole, never skipped and never carried over from the last good read. Skipping
// it draws a straight line across a period when nothing was measured, which is
// the one invented thing on an otherwise measured screen; carrying the last
// value over is worse, because it looks like a machine sitting at a steady
// number when in fact nobody was asking.

export type Series = { cpu: SparklinePoint[]; memory: SparklinePoint[]; gpu: SparklinePoint[] };

/** What a poll produced, or null when the read failed entirely. */
export type Sample = {
  cpu: { fraction: number | null };
  memory: { fraction: number | null };
  gpu: { fraction: number | null };
} | null;

export const emptySeries = (): Series => ({ cpu: [], memory: [], gpu: [] });

export function pushSample(prior: Series, sample: Sample, limit: number): Series {
  const push = (series: SparklinePoint[], value: number | null) =>
    [...series, value].slice(-limit);

  return {
    cpu: push(prior.cpu, sample?.cpu.fraction ?? null),
    memory: push(prior.memory, sample?.memory.fraction ?? null),
    gpu: push(prior.gpu, sample?.gpu.fraction ?? null)
  };
}
