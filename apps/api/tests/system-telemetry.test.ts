import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  cpuBusyFraction,
  formatGigabytes,
  parseGpuLine,
  readMemory,
  readTelemetry,
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
  assert.match(parsed.detail, /1\.3 of 8\.0 GB/);
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
  assert.match(memory.detail, /^[\d.]+ of [\d.]+ GB$/);
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
