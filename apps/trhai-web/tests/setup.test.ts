import test from "node:test";
import assert from "node:assert/strict";
import {
  describeHardware, formatBytes, initialSelection, initialToolSelection, jobPercent, plannedBytes, setupReason, stepText, toolHasMore, toolRemainingBytes,
  type SetupStatus, type ToolEntry
} from "../src/lib/setup.js";

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
    installed: [], tools: [], needsSetup: true, recommendedModel: "small", runtimeDir: "C:\runtime", freeBytes: 40 * gib, job: null, ...overrides
  };
}

const mib = 1024 ** 2;
function tool(id: string, overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    id, label: id, summary: "", needs: "", license: { name: "MIT", url: "https://example.test", commercialUse: true },
    installed: false, sizeBytes: 100 * mib, supported: true, ...overrides
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

test("every tool that is not installed starts ticked and counts in the download; one that is installed never does", () => {
  const fresh = status({ tools: [tool("speech", { sizeBytes: 130 * mib }), tool("listening", { sizeBytes: 150 * mib }), tool("video", { installed: true, sizeBytes: 0 })] });
  assert.deepEqual(initialToolSelection(fresh), ["speech", "listening"]);
  assert.equal(plannedBytes(fresh, ["small"], ["speech", "listening"]), 2.5 * gib + 19_328_326 + 280 * mib);
  assert.equal(plannedBytes(fresh, [], ["video"]), 19_328_326, "an installed tool adds nothing, even if it is ticked");
  assert.equal(plannedBytes(fresh, ["small"]), 2.5 * gib + 19_328_326, "with no tools ticked, the tools are not counted");
});

test("a tool that works but is short of some of its own parts (one voice of five) is offered ticked, and counts only what is missing", () => {
  const oneVoice = tool("speech", { installed: true, sizeBytes: 0, missingBytes: 400 * mib });
  const fresh = status({ tools: [oneVoice, tool("video", { installed: true, sizeBytes: 0, missingBytes: 0 })] });
  assert.equal(toolHasMore(oneVoice), true);
  assert.equal(toolRemainingBytes(oneVoice), 400 * mib);
  assert.deepEqual(initialToolSelection(fresh), ["speech"], "the complete tool is left out");
  assert.equal(plannedBytes(fresh, [], ["speech", "video"]), 19_328_326 + 400 * mib);
  // A service that does not say what is missing is read as before: installed means nothing is left.
  const older = tool("speech", { installed: true, sizeBytes: 0 });
  assert.equal(toolHasMore(older), false);
  assert.equal(toolRemainingBytes(older), 0);
  assert.equal(toolRemainingBytes(tool("speech", { sizeBytes: 130 * mib })), 130 * mib, "not installed: all of it");
});

test("being short of a tool's own parts is not a reason to open the setup screen by itself", () => {
  // The update installs them without asking (the API's required setup); a screen asking again would be a second question.
  const ready = status({ needsSetup: false, tools: [tool("speech", { installed: true, sizeBytes: 0, missingBytes: 400 * mib })] });
  assert.equal(setupReason(ready, false), null);
});

test("a tool this PC cannot use is not offered ticked", () => {
  const other = status({ tools: [tool("speech", { supported: false }), tool("video")] });
  assert.deepEqual(initialToolSelection(other), ["video"]);
});

test("a service that sends no tools gives no tool choices and no extra download", () => {
  const older = status({ tools: undefined as unknown as ToolEntry[] });
  assert.deepEqual(initialToolSelection(older), []);
  assert.equal(plannedBytes(older, ["small"], ["speech"]), 2.5 * gib + 19_328_326);
});

test("a PC with nothing to answer with gets the first-run screen, whether or not it was offered the tools", () => {
  const fresh = status({ tools: [tool("speech")] });
  assert.equal(setupReason(fresh, false), "first-run");
  assert.equal(setupReason(fresh, true), "first-run");
});

test("a PC that can answer is offered the tools it lacks once, and then left alone", () => {
  const ready = status({ needsSetup: false, tools: [tool("speech"), tool("listening", { installed: true, sizeBytes: 0 })] });
  assert.equal(setupReason(ready, false), "tools");
  assert.equal(setupReason(ready, true), null, "once it has been offered, it is not offered again");
});

test("nothing is offered to a PC that can answer and has every tool, or cannot use them", () => {
  const complete = status({ needsSetup: false, tools: [tool("speech", { installed: true, sizeBytes: 0 }), tool("video", { installed: true, sizeBytes: 0 })] });
  assert.equal(setupReason(complete, false), null);
  const elsewhere = status({ needsSetup: false, tools: [tool("speech", { supported: false }), tool("video", { supported: false })] });
  assert.equal(setupReason(elsewhere, false), null);
  const older = status({ needsSetup: false, tools: undefined as unknown as ToolEntry[] });
  assert.equal(setupReason(older, false), null, "a service that sends no tools has none to offer");
});

test("a tool's step reads like any other step, and counts in the progress", () => {
  const job = {
    id: "j", state: "running" as const, startedAt: "", finishedAt: null, error: null,
    steps: [
      { kind: "model" as const, id: "small", label: "Small", totalBytes: 100, doneBytes: 100, state: "done" as const, error: null },
      { kind: "tool" as const, id: "speech", label: "Voice (Piper)", totalBytes: 100, doneBytes: 0, state: "downloading" as const, error: null }
    ]
  };
  assert.equal(jobPercent(job), 50);
  assert.match(stepText(job.steps[1]), /Downloading/);
  assert.equal(stepText({ ...job.steps[1], state: "unpacking" }), "Unpacking");
});
