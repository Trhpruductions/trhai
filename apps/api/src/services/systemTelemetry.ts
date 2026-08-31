import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
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
  /** What the card shows under the ring, e.g. "16.4 / 33.4 GB". */
  detail: string;
  /** Why there is no reading. Null whenever `fraction` is a number. */
  unavailable: string | null;
};

export type SystemTelemetry = {
  cpu: Reading & { model: string; cores: number; speedMhz: number };
  memory: Reading;
  gpu: Reading & {
    name: string | null;
    vram: Reading | null;
    /** Degrees Celsius. Null when the card did not report one. */
    temperatureC: number | null;
    clockMhz: number | null;
  };
  /**
   * Third-party services in use. Always empty: everything this build does
   * runs against this machine. The dashboard's "Cloud" card reports that as a
   * fact rather than leaving a space where a number is expected.
   */
  cloud: { services: string[]; detail: string };
  /** Free space on the volume this build lives on. */
  disk: Reading;
  /** Throughput since the previous reading, not a total since boot. */
  network: Reading & { receivedBytesPerSecond: number | null; sentBytesPerSecond: number | null };
  /** Whole seconds this machine has been up. */
  uptimeSeconds: number;
  takenAt: string;
};

/**
 * Who is actually sitting at this machine.
 *
 * The reference design has "USER: HANK" printed on it. Hank is the person who
 * commissioned this build, so hardcoding it would have looked correct on this
 * machine forever and been a lie on every other one. This reads the account
 * the process is running under, so the screen greets whoever opened it.
 */
export type Identity = {
  /** The OS account name, e.g. "hankh". */
  username: string;
  /** The machine's name. */
  hostname: string;
  platform: string;
};

export function readIdentity(): Identity {
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {
    // userInfo() throws when there is no passwd entry for the uid, which
    // happens in some containers. The env vars are the same answer by another
    // route, and an empty string is better than inventing a name.
    username = process.env.USERNAME ?? process.env.USER ?? "";
  }

  return {
    username: username.trim(),
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`
  };
}

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

/**
 * A used-of-total pair, in the largest unit that keeps both readable.
 *
 * "1677.8 of 3725.9 GB" is technically right and nobody can read it at a
 * glance, which on a 230px rail meant it was ellipsised down to "1677.8 of"
 * and stopped being a reading at all. Terabytes above a terabyte, and a slash
 * instead of "of", is the same fact in half the width.
 */
export function formatPair(used: number, total: number): string {
  const terabyte = 1024 ** 4;
  if (total >= terabyte) {
    return `${(used / terabyte).toFixed(2)} / ${(total / terabyte).toFixed(2)} TB`;
  }
  return `${formatGigabytes(used)} / ${formatGigabytes(total)} GB`;
}

/** Parses one CSV line of `nvidia-smi` output. */
export function parseGpuLine(line: string): {
  name: string;
  fraction: number;
  detail: string;
  /** Video memory, as its own reading. Null when the card did not report it. */
  vram: Reading | null;
  /** Degrees Celsius, or null when the card did not report a temperature. */
  temperatureC: number | null;
  /** Core clock in MHz, or null when not reported. */
  clockMhz: number | null;
} | null {
  // name, utilisation %, memory used MiB, memory total MiB
  const parts = line.split(",").map((part) => part.trim());
  if (parts.length < 4) return null;

  const [name, utilisation, used, total, temperature, clock] = parts;
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
      detail: formatPair(usedMib * 1024 ** 2, totalMib * 1024 ** 2),
      unavailable: null
    }
    : null;

  // Reported only when the card actually gave a number. A temperature is a
  // physical measurement; inventing one would be the worst kind of fake
  // reading, because nothing on screen would look more real.
  const celsius = Number.parseFloat(temperature ?? "");
  const mhz = Number.parseFloat(clock ?? "");

  return {
    name,
    fraction: Math.min(1, Math.max(0, percent / 100)),
    detail: `${Math.round(percent)}% busy${vram ? ` · ${vram.detail}` : ""}`,
    vram,
    temperatureC: Number.isFinite(celsius) ? celsius : null,
    clockMhz: Number.isFinite(mhz) ? mhz : null
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
    vram: null,
    temperatureC: null,
    clockMhz: null
  });

  const output = await new Promise<string | null>((resolve) => {
    execFile(
      "nvidia-smi",
      [
        "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,clocks.current.graphics",
        "--format=csv,noheader,nounits"
      ],
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
    vram: parsed.vram,
    temperatureC: parsed.temperatureC,
    clockMhz: parsed.clockMhz
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
    detail: formatPair(used, total),
    unavailable: null
  };
}

/**
 * Free space on the volume this process is running from.
 *
 * statfs is used rather than shelling out to wmic or df: it is a syscall, it
 * works on every platform Node supports, and it cannot be defeated by a
 * locale that prints numbers differently.
 */
export async function readDisk(path: string = process.cwd()): Promise<Reading> {
  try {
    const stats = await statfs(path);
    // bsize * blocks is the size the filesystem reports. bavail rather than
    // bfree: bfree counts blocks reserved for root that this process cannot
    // actually use, so it would show more space than really exists.
    const total = stats.bsize * Number(stats.blocks);
    const available = stats.bsize * Number(stats.bavail);
    if (!Number.isFinite(total) || total <= 0) {
      return { fraction: null, detail: "", unavailable: "This volume did not report its size." };
    }

    const used = total - available;
    return {
      fraction: Math.min(1, Math.max(0, used / total)),
      detail: formatPair(used, total),
      unavailable: null
    };
  } catch {
    return { fraction: null, detail: "", unavailable: "This volume could not be measured." };
  }
}

/**
 * Cumulative interface byte counters, or null where they cannot be read.
 *
 * Exported for the tests, which feed it captured output from both platforms
 * rather than whatever the machine running the suite happens to have.
 */
export function parseNetstat(output: string): { received: number; sent: number } | null {
  // netstat -e prints a "Bytes" row with received and sent totals. The label
  // is localised on a non-English Windows, so the row is found by shape — the
  // first line holding exactly two large integers — rather than by its name.
  for (const line of output.split("\n")) {
    const numbers = line.trim().match(/\d+/g);
    if (!numbers || numbers.length !== 2) continue;
    if (!/^\s*\D+/.test(line)) continue;
    const received = Number(numbers[0]);
    const sent = Number(numbers[1]);
    // Packet-count rows also hold two numbers. Byte totals on any machine that
    // has done real work are far larger, and this is the first such row.
    if (received < 10_000 && sent < 10_000) continue;
    if (!Number.isFinite(received) || !Number.isFinite(sent)) continue;
    return { received, sent };
  }
  return null;
}

/** /proc/net/dev, summed across every interface except loopback. */
export function parseProcNetDev(output: string): { received: number; sent: number } | null {
  let received = 0;
  let sent = 0;
  let matched = false;

  for (const line of output.split("\n")) {
    const [rawName, rest] = line.split(":");
    if (rest === undefined) continue;
    const name = rawName.trim();
    // Loopback is this machine talking to itself, which includes every call
    // the web app makes to its own API — counting it would make the meter
    // read the dashboard's own polling.
    if (name === "lo" || name.length === 0) continue;
    const fields = rest.trim().split(/\s+/).map(Number);
    if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    received += fields[0];
    sent += fields[8];
    matched = true;
  }

  return matched ? { received, sent } : null;
}

const netTimeoutMs = 2_000;

/** The previous counter reading, so throughput is a real delta over real time. */
let previousNetwork: { received: number; sent: number; at: number } | null = null;

/** Only for the tests, which must not inherit a sample from another case. */
export function resetNetworkBaseline(): void {
  previousNetwork = null;
}

async function readNetworkCounters(): Promise<{ received: number; sent: number } | null> {
  if (process.platform === "linux") {
    try {
      return parseProcNetDev(await readFile("/proc/net/dev", "utf8"));
    } catch {
      return null;
    }
  }

  if (process.platform !== "win32") return null;

  // netstat -e rather than PowerShell's Get-NetAdapterStatistics: it is a
  // small native binary that answers in milliseconds, where starting
  // PowerShell costs most of a second on every poll.
  const output = await new Promise<string | null>((resolve) => {
    execFile("netstat", ["-e"], { timeout: netTimeoutMs, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout));
  });

  return output === null ? null : parseNetstat(output);
}

/* Short enough for a 230px rail. "92 kB/s" spelled out alongside its pair and
   a separator overran the column and was ellipsised away entirely, so the unit
   drops to a single letter and the pair is separated by a space. */
function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1_000_000) return `${(bytesPerSecond / 1_000_000).toFixed(1)}M`;
  if (bytesPerSecond >= 1_000) return `${Math.round(bytesPerSecond / 1_000)}k`;
  return `${Math.round(bytesPerSecond)}B`;
}

/**
 * Network throughput since the previous reading.
 *
 * The first call after start has nothing to subtract from, so it reports no
 * reading rather than treating the since-boot total as a one-second rate —
 * which would show a gigabyte per second on a machine that had been up a week.
 */
export async function readNetwork(): Promise<SystemTelemetry["network"]> {
  const absent = (reason: string): SystemTelemetry["network"] => ({
    fraction: null,
    detail: "",
    unavailable: reason,
    receivedBytesPerSecond: null,
    sentBytesPerSecond: null
  });

  const counters = await readNetworkCounters();
  if (!counters) return absent("Network counters are not readable on this machine.");

  const now = Date.now();
  const previous = previousNetwork;
  previousNetwork = { ...counters, at: now };

  if (!previous) return absent("Measuring…");

  const seconds = (now - previous.at) / 1000;
  if (seconds <= 0) return absent("Measuring…");

  // A counter that went backwards means the adapter was reset or swapped.
  // Clamping at zero keeps a restart from showing as negative throughput.
  const down = Math.max(0, counters.received - previous.received) / seconds;
  const up = Math.max(0, counters.sent - previous.sent) / seconds;

  return {
    // There is no honest denominator here: link speed is not what a connection
    // actually delivers, so this has a detail line and no ring fraction.
    fraction: null,
    detail: `↓${formatRate(down)}  ↑${formatRate(up)}/s`,
    unavailable: null,
    receivedBytesPerSecond: down,
    sentBytesPerSecond: up
  };
}

/** How long the two CPU samples are spaced. Long enough to be a real rate. */
const cpuWindowMs = 250;

export async function readTelemetry(): Promise<SystemTelemetry> {
  const cpus = os.cpus();
  const first = sampleCpu(cpus);

  // Everything slow happens while the CPU window elapses rather than after it,
  // so the whole request costs one wait instead of four.
  const [gpu, disk, network] = await Promise.all([
    readGpu(),
    readDisk(),
    readNetwork(),
    new Promise((resolve) => setTimeout(resolve, cpuWindowMs))
  ]);

  const busy = cpuBusyFraction(first, sampleCpu());

  return {
    cpu: {
      model: cpus[0]?.model.trim() ?? "Unknown processor",
      cores: cpus.length,
      speedMhz: cpus[0]?.speed ?? 0,
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
    disk,
    network,
    uptimeSeconds: Math.floor(os.uptime()),
    takenAt: new Date().toISOString()
  };
}
