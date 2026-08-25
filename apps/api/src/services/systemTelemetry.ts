import { execFile } from "node:child_process";
import os from "node:os";

// What this machine is actually doing right now.
//
// The dashboard shows rings for CPU, memory and GPU. A ring is a claim about
// hardware, so every number here is read from the machine and nothing is
// filled in to keep a ring moving. Where a reading cannot be taken, the card
// says so instead of showing a plausible number, because a fabricated 40% is
// worse than an honest "not available" — it cannot be told apart from a real
// one by looking.
//
// os.loadavg() is deliberately not used. On Windows it is a hardcoded
// [0, 0, 0] rather than a measurement, so a ring driven by it would sit flat
// forever while looking exactly like live telemetry. CPU is measured from
// os.cpus() deltas instead, which move on every platform.

export type Reading = {
  /** 0–1, or null when this machine cannot be asked. */
  fraction: number | null;
  /** What the card shows under the ring, e.g. "16.4 of 33.4 GB". */
  detail: string;
  /** Why there is no reading. Null whenever `fraction` is a number. */
  unavailable: string | null;
};

export type SystemTelemetry = {
  cpu: Reading & { model: string; cores: number };
  memory: Reading;
  gpu: Reading & { name: string | null; vram: Reading | null };
  /**
   * Third-party services in use. Always empty: everything this build does
   * runs against this machine. The dashboard's "Cloud" card reports that as a
   * fact rather than leaving a space where a number is expected.
   */
  cloud: { services: string[]; detail: string };
  /** Whole seconds this machine has been up. */
  uptimeSeconds: number;
  takenAt: string;
};

type CpuSample = { idle: number; total: number };

/**
 * Cumulative busy/idle tick counts across every core.
 *
 * These are totals since boot, not a rate, which is why a single sample says
 * nothing useful — utilisation is the change between two of them.
 */
export function sampleCpu(cpus: os.CpuInfo[] = os.cpus()): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/**
 * Busy fraction between two samples, or null when it cannot be computed.
 *
 * Two samples taken close together can show no elapsed ticks at all; that is
 * "ask again shortly", not "the processor was idle", so it returns null
 * rather than a confident zero.
 */
export function cpuBusyFraction(first: CpuSample, second: CpuSample): number | null {
  const total = second.total - first.total;
  if (total <= 0) return null;

  const idle = second.idle - first.idle;
  const busy = 1 - idle / total;
  // Clamped because the counters are read per-core and can disagree by a tick
  // across a sample boundary, which is enough to land just outside 0–1.
  return Math.min(1, Math.max(0, busy));
}

export function formatGigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** Parses one CSV line of `nvidia-smi` output. */
export function parseGpuLine(line: string): {
  name: string;
  fraction: number;
  detail: string;
  /** Video memory, as its own reading. Null when the card did not report it. */
  vram: Reading | null;
} | null {
  // name, utilisation %, memory used MiB, memory total MiB
  const parts = line.split(",").map((part) => part.trim());
  if (parts.length < 4) return null;

  const [name, utilisation, used, total] = parts;
  const percent = Number.parseFloat(utilisation);
  const usedMib = Number.parseFloat(used);
  const totalMib = Number.parseFloat(total);
  if (!name || !Number.isFinite(percent)) return null;

  // Video memory is a separate fact from GPU load — a card can sit at 2% busy
  // with its memory nearly full, and a dashboard showing only one of those is
  // hiding the number that actually explains a stall.
  const haveMemory = Number.isFinite(usedMib) && Number.isFinite(totalMib) && totalMib > 0;
  const vram: Reading | null = haveMemory
    ? {
      fraction: Math.min(1, Math.max(0, usedMib / totalMib)),
      detail: `${(usedMib / 1024).toFixed(1)} of ${(totalMib / 1024).toFixed(1)} GB`,
      unavailable: null
    }
    : null;

  return {
    name,
    fraction: Math.min(1, Math.max(0, percent / 100)),
    detail: `${Math.round(percent)}% busy${vram ? ` · ${vram.detail}` : ""}`,
    vram
  };
}

const gpuTimeoutMs = 2_000;

/**
 * GPU load via nvidia-smi, when there is one to ask.
 *
 * Only NVIDIA cards answer this. An AMD or Intel GPU, or no discrete GPU at
 * all, is a perfectly ordinary machine — so a missing nvidia-smi is reported
 * as "no NVIDIA GPU detected" rather than treated as an error, and certainly
 * not filled in with a number.
 */
export async function readGpu(): Promise<SystemTelemetry["gpu"]> {
  const absent = (reason: string): SystemTelemetry["gpu"] => ({
    name: null,
    fraction: null,
    detail: "",
    unavailable: reason,
    vram: null
  });

  const output = await new Promise<string | null>((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
      { timeout: gpuTimeoutMs, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout)
    );
  });

  if (output === null) {
    return absent("No NVIDIA GPU detected on this machine.");
  }

  const first = output.split("\n").find((line) => line.trim().length > 0);
  const parsed = first ? parseGpuLine(first) : null;
  if (!parsed) {
    return absent("The GPU answered in a format this build could not read.");
  }

  return {
    name: parsed.name,
    fraction: parsed.fraction,
    detail: parsed.detail,
    unavailable: null,
    vram: parsed.vram
  };
}

export function readMemory(): Reading {
  const total = os.totalmem();
  const free = os.freemem();
  if (total <= 0) {
    return { fraction: null, detail: "", unavailable: "This machine did not report its memory." };
  }

  const used = total - free;
  return {
    fraction: Math.min(1, Math.max(0, used / total)),
    detail: `${formatGigabytes(used)} of ${formatGigabytes(total)} GB`,
    unavailable: null
  };
}

/** How long the two CPU samples are spaced. Long enough to be a real rate. */
const cpuWindowMs = 250;

export async function readTelemetry(): Promise<SystemTelemetry> {
  const cpus = os.cpus();
  const first = sampleCpu(cpus);

  // The GPU is read while the CPU window elapses rather than after it, so the
  // request costs one wait instead of two.
  const [gpu] = await Promise.all([
    readGpu(),
    new Promise((resolve) => setTimeout(resolve, cpuWindowMs))
  ]);

  const busy = cpuBusyFraction(first, sampleCpu());

  return {
    cpu: {
      model: cpus[0]?.model.trim() ?? "Unknown processor",
      cores: cpus.length,
      fraction: busy,
      detail: busy === null ? "" : `${Math.round(busy * 100)}% across ${cpus.length} cores`,
      unavailable: busy === null ? "No processor time elapsed between samples." : null
    },
    memory: readMemory(),
    gpu,
    cloud: {
      services: [],
      detail: "Nothing leaves this machine. No cloud services are in use."
    },
    uptimeSeconds: Math.floor(os.uptime()),
    takenAt: new Date().toISOString()
  };
}
