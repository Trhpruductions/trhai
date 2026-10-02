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
    /** Board power draw in watts. Null when the card did not report one. */
    powerWatts: number | null;
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
  /** Board power draw in watts, or null when not reported. */
  powerWatts: number | null;
} | null {
  // name, utilisation %, memory used MiB, memory total MiB
  const parts = line.split(",").map((part) => part.trim());
  if (parts.length < 4) return null;

  const [name, utilisation, used, total, temperature, clock, power] = parts;
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
  const watts = Number.parseFloat(power ?? "");

  return {
    name,
    fraction: Math.min(1, Math.max(0, percent / 100)),
    detail: `${Math.round(percent)}% busy${vram ? ` · ${vram.detail}` : ""}`,
    vram,
    temperatureC: Number.isFinite(celsius) ? celsius : null,
    clockMhz: Number.isFinite(mhz) ? mhz : null,
    powerWatts: Number.isFinite(watts) ? watts : null
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
    clockMhz: null,
    powerWatts: null
  });

  const output = await new Promise<string | null>((resolve) => {
    execFile(
      "nvidia-smi",
      [
        "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,clocks.current.graphics,power.draw",
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
    clockMhz: parsed.clockMhz,
    powerWatts: parsed.powerWatts
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

/**
 * How far the graphics card is below the temperature where it starts slowing
 * itself down, in degrees, as the card reports it - or null.
 *
 * Asked "is my GPU too hot?" at 64°C, the model answered "Yes, your GPU is too
 * hot... consider shutting it down" - wrong, and alarming. A temperature means
 * little without the card's own limit, and the card knows its limit:
 * nvidia-smi's temperature.gpu.tlimit is the margin to it. Asked separately
 * from the dashboard's query, because a driver too old to know the field fails
 * the whole query, and the dashboard's reading must not depend on it.
 */
export async function readGpuHeadroom(): Promise<number | null> {
  const output = await new Promise<string | null>((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=temperature.gpu.tlimit", "--format=csv,noheader,nounits"],
      { timeout: gpuTimeoutMs, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout));
  });
  const value = Number.parseFloat(output?.split("\n").find((line) => line.trim())?.trim() ?? "");
  return Number.isFinite(value) ? value : null;
}

export type ProgramMemory = { name: string; bytes: number; processes: number };

/**
 * `tasklist /fo csv /nh` rows, summed per program: chrome is dozens of
 * processes and one answer. The size column is in K with the locale's own
 * thousands separator ("1,240,920 K", "1.240.920 K"), so only its digits are
 * kept.
 */
export function parseTasklist(output: string): ProgramMemory[] {
  const totals = new Map<string, ProgramMemory>();
  for (const line of output.split(/\r?\n/)) {
    const fields = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    if (fields.length < 5) continue;
    const kilobytes = Number(fields[4].replace(/\D/g, ""));
    if (!fields[0] || !Number.isFinite(kilobytes) || kilobytes <= 0) continue;
    const name = fields[0].replace(/\.exe$/i, "");
    const entry = totals.get(name.toLowerCase()) ?? { name, bytes: 0, processes: 0 };
    entry.bytes += kilobytes * 1024;
    entry.processes += 1;
    totals.set(name.toLowerCase(), entry);
  }
  return [...totals.values()].sort((left, right) => right.bytes - left.bytes);
}

/** `ps -eo comm=,rss=` rows (resident size in KB), summed per program. */
export function parsePs(output: string): ProgramMemory[] {
  const totals = new Map<string, ProgramMemory>();
  for (const line of output.split("\n")) {
    const found = /^\s*(.+?)\s+(\d+)\s*$/.exec(line);
    if (!found) continue;
    const entry = totals.get(found[1]) ?? { name: found[1], bytes: 0, processes: 0 };
    entry.bytes += Number(found[2]) * 1024;
    entry.processes += 1;
    totals.set(found[1], entry);
  }
  return [...totals.values()].sort((left, right) => right.bytes - left.bytes);
}

/**
 * The programs holding the most memory right now, or null where they cannot
 * be listed.
 *
 * Asked "which process is using the most RAM?", the model had the machine's
 * totals and nothing per program, and answered that it was "not specified".
 * The process list is the answer, read the same way every time.
 */
export async function readTopMemoryPrograms(limit = 5): Promise<ProgramMemory[] | null> {
  const [command, args, parse] = process.platform === "win32"
    ? ["tasklist", ["/fo", "csv", "/nh"], parseTasklist] as const
    : ["ps", ["-eo", "comm=,rss="], parsePs] as const;
  const output = await new Promise<string | null>((resolve) => {
    execFile(command, [...args], { timeout: 4_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout));
  });
  if (output === null) return null;
  const programs = parse(output);
  return programs.length > 0 ? programs.slice(0, limit) : null;
}

/** "1.2 GB", "643.8 MB": one program's memory, in the unit that reads at a glance. */
export function formatProgramMemory(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** Free and total bytes on the volume holding `path`, or null when it cannot be measured. */
export async function readFreeSpace(path: string): Promise<{ free: number; total: number } | null> {
  try {
    const stats = await statfs(path);
    const total = stats.bsize * Number(stats.blocks);
    const free = stats.bsize * Number(stats.bavail);
    return Number.isFinite(total) && total > 0 && Number.isFinite(free) ? { free, total } : null;
  } catch {
    return null;
  }
}

/** One size, in the unit that reads at a glance: "412.3 GB", "1.64 TB". */
export function formatSize(bytes: number): string {
  const terabyte = 1024 ** 4;
  return bytes >= terabyte ? `${(bytes / terabyte).toFixed(2)} TB` : `${formatGigabytes(bytes)} GB`;
}

/** "3 days 4 hours", "2 hours 5 minutes", "12 minutes". */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"}`;
  if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day");
  if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour");
  return unit(minutes, "minute");
}

/**
 * The readings, as sentences the assistant can answer from.
 *
 * Asked "what's my CPU usage right now?", the model had no way to read it: it
 * ran `wmic`, which this Windows no longer has, and answered with directions to
 * Task Manager; another time it ran a PowerShell counter and answered
 * "approximately 0.265625". Asked how much RAM was in use, it listed the
 * biggest processes and never gave the total. The dashboard was showing all of
 * it from this file the whole time.
 *
 * A reading that could not be taken says so and why. Nothing here is filled in
 * to make a sentence complete: a temperature the card did not report is left
 * out rather than guessed.
 */
export function describeTelemetry(
  telemetry: SystemTelemetry,
  disk: { label: string; space: { free: number; total: number } | null },
  /** The card's margin below its slow-down temperature; see readGpuHeadroom. */
  gpuHeadroomC: number | null = null,
  /** The programs holding the most memory; see readTopMemoryPrograms. */
  topMemory: ProgramMemory[] | null = null
): string {
  const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
  // The reasons are written as sentences for the dashboard; here they follow a dash.
  const why = (reason: string | null, fallback: string) => {
    const text = (reason ?? fallback).trim().replace(/[.!]+$/, "");
    return `${text.charAt(0).toLowerCase()}${text.slice(1)}.`;
  };
  const { cpu, memory, gpu, network } = telemetry;
  const lines: string[] = [];

  lines.push(cpu.fraction === null
    ? `Processor: no reading - ${why(cpu.unavailable, "it could not be measured just now")}`
    : `Processor: ${percent(cpu.fraction)} busy across ${cpu.cores} cores (${cpu.model}).`);

  lines.push(memory.fraction === null
    ? `Memory: no reading - ${why(memory.unavailable, "it could not be measured")}`
    : `Memory: ${memory.detail} in use (${percent(memory.fraction)}).`);
  if (topMemory && topMemory.length > 0) {
    lines.push(`Programs using the most memory: ${topMemory.map((program) =>
      `${program.name} ${formatProgramMemory(program.bytes)}${program.processes > 1 ? ` (${program.processes} processes)` : ""}`)
      .join(", ")}. Processor use per program is not measured here.`);
  }

  if (gpu.fraction === null || !gpu.name) {
    lines.push(`Graphics card: no reading - ${why(gpu.unavailable, "it did not answer")}`);
  } else {
    const parts = [`${percent(gpu.fraction)} busy`];
    if (gpu.vram && gpu.vram.fraction !== null) parts.push(`video memory ${gpu.vram.detail} (${percent(gpu.vram.fraction)})`);
    if (gpu.temperatureC !== null) {
      parts.push(gpuHeadroomC !== null && gpuHeadroomC >= 0
        ? `${Math.round(gpu.temperatureC)}°C, which is ${Math.round(gpuHeadroomC)}°C below the point where the card `
          + `starts slowing itself down to stay cool (about ${Math.round(gpu.temperatureC + gpuHeadroomC)}°C)`
        : `${Math.round(gpu.temperatureC)}°C`);
    }
    if (gpu.powerWatts !== null) parts.push(`drawing ${Math.round(gpu.powerWatts)} W`);
    lines.push(`Graphics card: ${gpu.name}, ${parts.join(", ")}.`);
  }

  // "Drive D:" on Windows, "Disk /:" elsewhere - never "Disk D::".
  const where = disk.label.endsWith(":") ? `Drive ${disk.label}` : `Disk ${disk.label}:`;
  lines.push(disk.space
    ? `${where} ${formatSize(disk.space.free)} free of ${formatSize(disk.space.total)} `
      + `(${percent((disk.space.total - disk.space.free) / disk.space.total)} used).`
    : `${where} no reading - that drive could not be measured.`);

  if (network.receivedBytesPerSecond !== null && network.sentBytesPerSecond !== null) {
    lines.push(`Network: ${network.detail.replace(/\s+/g, " ")}.`);
  }
  lines.push(`Up for: ${formatUptime(telemetry.uptimeSeconds)}.`);
  return lines.join("\n");
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
