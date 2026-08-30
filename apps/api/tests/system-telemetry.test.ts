import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  cpuBusyFraction,
  formatGigabytes,
  formatPair,
  parseGpuLine,
  parseNetstat,
  parseProcNetDev,
  readDisk,
  readIdentity,
  readMemory,
  readNetwork,
  readTelemetry,
  resetNetworkBaseline,
  sampleCpu
} from "../src/services/systemTelemetry.js";

// These rings are a claim about hardware, so the tests care about two things:
// that the arithmetic is right, and that an unreadable sensor produces "not
// available" rather than a number nobody can tell apart from a real one.

function fakeCpu(times: Partial<os.CpuInfo["times"]>): os.CpuInfo {
  return {
    model: "Test CPU",
    speed: 3000,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, ...times }
  };
}

test("a cpu sample totals every core, not just the first", () => {
  const sample = sampleCpu([
    fakeCpu({ user: 10, idle: 90 }),
    fakeCpu({ user: 30, idle: 70 })
  ]);

  assert.equal(sample.total, 200);
  assert.equal(sample.idle, 160);
});

test("utilisation is the change between samples, not a single reading", () => {
  // Half the ticks in this window were idle.
  const busy = cpuBusyFraction({ idle: 100, total: 200 }, { idle: 150, total: 300 });
  assert.equal(busy, 0.5);
});

test("a fully idle window reads as zero rather than as no reading", () => {
  assert.equal(cpuBusyFraction({ idle: 0, total: 0 }, { idle: 100, total: 100 }), 0);
});

test("two samples with no elapsed time report nothing, not an idle processor", () => {
  // Sampled twice in the same instant. "Ask again shortly" and "the machine
  // was doing nothing" are different facts, and a confident 0% here would be
  // the second one asserted from evidence for neither.
  assert.equal(cpuBusyFraction({ idle: 100, total: 200 }, { idle: 100, total: 200 }), null);
});

test("counters that drift across a sample boundary stay inside the ring", () => {
  // Per-core counters are read one after another and can disagree by a tick,
  // which is enough to compute slightly outside 0-1.
  const over = cpuBusyFraction({ idle: 100, total: 200 }, { idle: 99, total: 300 });
  assert.ok(over !== null && over <= 1 && over >= 0, `expected a clamped fraction, got ${over}`);
});

test("gigabytes are formatted the way the card shows them", () => {
  assert.equal(formatGigabytes(1024 ** 3), "1.0");
  assert.equal(formatGigabytes(0), "0.0");
});

test("an nvidia-smi line becomes a reading", () => {
  const parsed = parseGpuLine("NVIDIA GeForce RTX 4060 Ti, 24, 1355, 8188");

  assert.ok(parsed);
  assert.equal(parsed.name, "NVIDIA GeForce RTX 4060 Ti");
  assert.ok(Math.abs(parsed.fraction - 0.24) < 1e-9);
  assert.match(parsed.detail, /24% busy/);
  assert.match(parsed.detail, /1\.3 \/ 8\.0 GB/);
});

test("a gpu line missing its memory figures still reports utilisation", () => {
  const parsed = parseGpuLine("Some GPU, 50, [N/A], [N/A]");

  assert.ok(parsed);
  assert.equal(parsed.fraction, 0.5);
  assert.equal(parsed.detail, "50% busy", "no memory clause rather than NaN GB");
});

test("unreadable gpu output is refused rather than guessed at", () => {
  assert.equal(parseGpuLine(""), null);
  assert.equal(parseGpuLine("just one field"), null);
  assert.equal(parseGpuLine("A GPU, not-a-number, 1, 2"), null);
});

test("memory is read from this machine and adds up", () => {
  const memory = readMemory();

  assert.equal(memory.unavailable, null);
  assert.ok(memory.fraction !== null && memory.fraction > 0 && memory.fraction < 1,
    `expected a real fraction, got ${memory.fraction}`);
  assert.match(memory.detail, /^[\d.]+ \/ [\d.]+ (GB|TB)$/);
});

test("a full reading describes this machine, and says plainly there is no cloud", async () => {
  const telemetry = await readTelemetry();

  assert.ok(telemetry.cpu.cores > 0);
  assert.ok(telemetry.cpu.model.length > 0);
  // Either a real number or a stated reason; never a number with no basis.
  assert.ok(telemetry.cpu.fraction !== null || telemetry.cpu.unavailable !== null);
  assert.ok(telemetry.gpu.fraction !== null || telemetry.gpu.unavailable !== null);

  assert.deepEqual(telemetry.cloud.services, [], "this build talks to nothing off this machine");
  assert.ok(telemetry.uptimeSeconds > 0);
  assert.ok(Number.isFinite(Date.parse(telemetry.takenAt)));
});

test("a reading never carries both a number and a reason it is missing", async () => {
  const telemetry = await readTelemetry();

  for (const [name, reading] of Object.entries({
    cpu: telemetry.cpu, memory: telemetry.memory, gpu: telemetry.gpu
  })) {
    if (reading.fraction !== null) {
      assert.equal(reading.unavailable, null, `${name} has a value and an excuse`);
      assert.ok(reading.fraction >= 0 && reading.fraction <= 1, `${name} outside 0-1`);
    } else {
      assert.ok((reading.unavailable ?? "").length > 0, `${name} is missing with no reason given`);
    }
  }
});

// --- identity -------------------------------------------------------------

test("identity reports the real account rather than a constant", () => {
  const identity = readIdentity();

  // The point of this endpoint is that the screen greets whoever opened the
  // app. A build that shipped a hardcoded name would pass every other test in
  // this file, so this asserts the value tracks the machine.
  assert.equal(identity.hostname, os.hostname());
  assert.equal(identity.platform, `${os.platform()} ${os.release()}`);
  assert.equal(typeof identity.username, "string");
  assert.notEqual(identity.username.toLowerCase(), "hank the owner");
});

// --- disk -----------------------------------------------------------------

test("disk reports a real fraction for a path that exists", async () => {
  const reading = await readDisk(process.cwd());

  assert.equal(reading.unavailable, null);
  assert.ok(reading.fraction !== null && reading.fraction >= 0 && reading.fraction <= 1,
    `expected a 0..1 fraction, got ${reading.fraction}`);
  assert.match(reading.detail, /^[\d.]+ \/ [\d.]+ (GB|TB)$/);
});

test("disk says so rather than guessing when the path cannot be measured", async () => {
  const reading = await readDisk("/definitely-not-a-real-volume-xyzzy");

  assert.equal(reading.fraction, null);
  assert.ok(reading.unavailable);
});

// --- network --------------------------------------------------------------

test("netstat output is parsed by shape, not by an English label", () => {
  // A localised Windows prints different words with the same numbers, so the
  // parser must not depend on the word "Bytes".
  const parsed = parseNetstat([
    "Schnittstellenstatistik",
    "",
    "                           Empfangen            Gesendet",
    "",
    "Bytes                    4085770558          704092842",
    "Unicastpakete               3548271             2894110"
  ].join("\n"));

  assert.deepEqual(parsed, { received: 4085770558, sent: 704092842 });
});

test("netstat parsing returns null rather than a number it could not find", () => {
  assert.equal(parseNetstat("nothing useful here"), null);
});

test("/proc/net/dev is summed across interfaces and excludes loopback", () => {
  // Loopback carries the web app's own calls to its own API. Counting it would
  // make the meter read the dashboard's polling rather than the network.
  const parsed = parseProcNetDev([
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets",
    "    lo: 999999999  1000    0    0    0     0          0         0 999999999   1000",
    "  eth0: 1000       10     0    0    0     0          0         0 2000        20",
    "  eth1: 500        5      0    0    0     0          0         0 750         7"
  ].join("\n"));

  assert.deepEqual(parsed, { received: 1500, sent: 2750 });
});

test("the first network reading reports no rate instead of a since-boot total", async () => {
  resetNetworkBaseline();
  const first = await readNetwork();

  // A cumulative counter divided by one second would read as gigabytes per
  // second on a machine that has been up a week. With nothing to subtract
  // from, the only honest answer is that there is no reading yet.
  assert.equal(first.receivedBytesPerSecond, null);
  assert.equal(first.sentBytesPerSecond, null);
  assert.ok(first.unavailable);
});

test("a used-of-total pair switches to terabytes when gigabytes stop being readable", () => {
  const gb = 1024 ** 3;
  const tb = 1024 ** 4;

  // Under a terabyte, gigabytes are the unit people think in.
  assert.equal(formatPair(19.2 * gb, 31.1 * gb), "19.2 / 31.1 GB");

  // Over it, they are not: this pair used to render "1677.8 of 3725.9 GB",
  // which a narrow rail truncated to "1677.8 of" — a reading nobody could read.
  assert.equal(formatPair(1.64 * tb, 3.64 * tb), "1.64 / 3.64 TB");
});
