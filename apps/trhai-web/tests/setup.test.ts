import test from "node:test";
import assert from "node:assert/strict";
import { describeHardware, formatBytes, initialSelection, jobPercent, plannedBytes, stepText, type SetupStatus } from "../src/lib/setup.js";

// What the setup screens work out from the API's answer.

const gib = 1024 ** 3;
function status(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    hardware: { totalMemoryBytes: 8 * gib, cpuCores: 4, gpu: null },
    engine: { installed: false, build: null, running: false, reason: "not installed", recommendedVariant: "cpu", downloadBytes: 19_328_326 },
    catalog: [
      { id: "small", label: "Small", summary: "", needs: "", license: { name: "Apache 2.0", url: "", commercialUse: true }, vision: false, sizeBytes: 2.5 * gib, installed: false, recommended: true },
      { id: "big", label: "Big", summary: "", needs: "", license: { name: "Apache 2.0", url: "", commercialUse: true }, vision: false, sizeBytes: 4.7 * gib, installed: false, recommended: false }
    ],
    installed: [], needsSetup: true, recommendedModel: "small", runtimeDir: "C:\runtime", freeBytes: 40 * gib, job: null, ...overrides
  };
}

test("a new PC starts with the recommended model picked, and the engine counted in the download", () => {
  const fresh = status();
  assert.deepEqual(initialSelection(fresh), ["small"]);
  assert.equal(plannedBytes(fresh, ["small"]), 2.5 * gib + 19_328_326);
  assert.equal(formatBytes(plannedBytes(fresh, ["small"])), "2.5 GB");
});

test("a PC that can already chat starts with nothing picked; a vision model alone does not count", () => {
  assert.deepEqual(initialSelection(status({ installed: [{ id: "x", sizeBytes: 1, vision: false, inCatalog: false }] })), []);
  assert.deepEqual(initialSelection(status({ installed: [{ id: "vl", sizeBytes: 1, vision: true, inCatalog: true }] })), ["small"]);
});

test("progress is by bytes across every step", () => {
  const job = {
    id: "j", state: "running" as const, startedAt: "", finishedAt: null, error: null,
    steps: [
      { kind: "engine" as const, id: "cpu", label: "Engine", totalBytes: 100, doneBytes: 100, state: "done" as const, error: null },
      { kind: "model" as const, id: "small", label: "Small", totalBytes: 300, doneBytes: 100, state: "downloading" as const, error: null }
    ]
  };
  assert.equal(jobPercent(job), 50);
  assert.equal(jobPercent({ ...job, steps: [], state: "done" }), 100);
  assert.match(stepText(job.steps[1]), /Downloading/);
  assert.equal(stepText({ ...job.steps[1], state: "failed", error: "did not match" }), "did not match");
});

test("the PC and sizes are described in words", () => {
  assert.equal(describeHardware(status().hardware), "8 GB of memory, 4 processor cores, no NVIDIA graphics card");
  assert.equal(describeHardware({ totalMemoryBytes: 32 * gib, cpuCores: 16, gpu: { vendor: "nvidia", name: "RTX 4060", memoryMiB: 8188, driver: "581" } }), "32 GB of memory, 16 processor cores, RTX 4060 with 8 GB");
  assert.equal(formatBytes(19_328_326), "18 MB");
  assert.equal(formatBytes(0), "0 MB");
});
