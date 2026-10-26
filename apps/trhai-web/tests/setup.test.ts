import test from "node:test";
import assert from "node:assert/strict";
import {
  describeHardware, formatBytes, initialSelection, initialToolSelection, jobPercent, plannedBytes, requiredNotice, setupReason, stepText, toolHasMore, toolRemainingBytes,
  type RequiredStatus, type SetupStatus, type ToolEntry
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

test("a new PC starts with the recommended chat model and the recommended picture model both picked, and counts both", () => {
  const fresh = status({
    catalog: [
      ...status().catalog,
      { id: "see", label: "See", summary: "", needs: "", license: { name: "Apache 2.0", url: "", commercialUse: true }, vision: true, sizeBytes: 2.9 * gib, installed: false, recommended: true }
    ]
  });
  assert.deepEqual(initialSelection(fresh), ["small", "see"]);
  assert.equal(plannedBytes(fresh, initialSelection(fresh)), 2.5 * gib + 2.9 * gib + 19_328_326);
  // A picture model already there is not picked again; one that is not the recommended is no reason to leave it out.
  const seeing = { ...fresh, installed: [{ id: "other-vl", sizeBytes: 1, vision: true, inCatalog: false }] };
  assert.deepEqual(initialSelection(seeing), ["small"]);
  // A PC that can already chat is left as it is.
  assert.deepEqual(initialSelection({ ...fresh, installed: [{ id: "x", sizeBytes: 1, vision: false, inCatalog: false }] }), []);
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

const requiredState = (overrides: Partial<RequiredStatus> = {}): RequiredStatus => ({
  generation: 1, applies: true, state: "waiting", error: null, attempts: 0, remainingBytes: 12 * gib, ...overrides
});
const requiredJob = {
  id: "j", state: "running" as const, startedAt: "", finishedAt: null, error: null,
  steps: [
    { kind: "model" as const, id: "a", label: "Qwen2.5 Coder 7B (no refusals)", totalBytes: 100, doneBytes: 100, state: "done" as const, error: null },
    { kind: "model" as const, id: "b", label: "Qwen3 VL 8B (pictures, no refusals)", totalBytes: 100, doneBytes: 50, state: "downloading" as const, error: null },
    { kind: "tool" as const, id: "speech", label: "Voice (Piper)", totalBytes: 200, doneBytes: 0, state: "waiting" as const, error: null }
  ]
};

test("the install an update brings is shown on a copy that is set up, in the words of how far it has got", () => {
  const running = requiredNotice(status({ needsSetup: false, job: requiredJob, required: requiredState({ state: "running" }) }));
  assert.ok(running);
  assert.equal(running.tone, "working");
  assert.equal(running.percent, 37, "by bytes across every step, rounded down: 150 of 400");
  assert.match(running.text, /now Qwen3 VL 8B \(pictures, no refusals\)/, "the step that is going, not one that is done or waiting");
  assert.deepEqual(running.action, { kind: "stop", label: "Stop" });

  const waiting = requiredNotice(status({ needsSetup: false, required: requiredState() }));
  assert.ok(waiting);
  assert.match(waiting.text, /12\.0 GB to download/);
  assert.deepEqual(waiting.action, { kind: "start", label: "Start now" });
  assert.equal(waiting.percent, null);

  // Running, but the job is not in the answer yet: no progress to show, and nothing breaks.
  const early = requiredNotice(status({ needsSetup: false, job: null, required: requiredState({ state: "running" }) }));
  assert.ok(early);
  assert.equal(early.percent, null);
  assert.doesNotMatch(early.text, /now /);
});

test("a stopped install, or one that did not finish, says what is left and why, and offers to carry on", () => {
  const failed = requiredNotice(status({ needsSetup: false, required: requiredState({ state: "failed", error: "Not enough free space: this needs about 14.3 GB and the drive has 9.0 GB. Free some space and try again.", remainingBytes: 5.5 * gib }) }));
  assert.ok(failed);
  assert.equal(failed.tone, "attention");
  assert.match(failed.title, /did not finish/);
  assert.match(failed.text, /Not enough free space: this needs about 14\.3 GB and the drive has 9\.0 GB/);
  assert.match(failed.text, /5\.5 GB still to download/);
  assert.deepEqual(failed.action, { kind: "start", label: "Try again" });

  const noReason = requiredNotice(status({ needsSetup: false, required: requiredState({ state: "failed", error: null }) }));
  assert.match(noReason?.text ?? "", /Something went wrong\./, "a failure with no reason still says something");

  const stopped = requiredNotice(status({ needsSetup: false, required: requiredState({ state: "stopped", remainingBytes: 7 * gib }) }));
  assert.ok(stopped);
  assert.equal(stopped.tone, "attention");
  assert.match(stopped.title, /was stopped/);
  assert.match(stopped.text, /7\.0 GB .* still to download.*What was fetched is kept/);
  assert.deepEqual(stopped.action, { kind: "start", label: "Continue" });
});

test("nothing is said of an install that is finished, that does not apply, or that an older service knows nothing of", () => {
  assert.equal(requiredNotice(null), null);
  assert.equal(requiredNotice(status({ needsSetup: false, required: requiredState({ state: "done", remainingBytes: 0 }) })), null);
  assert.equal(requiredNotice(status({ needsSetup: true, required: requiredState({ applies: false }) })), null, "a new install is asked by its first-run screen");
  assert.equal(requiredNotice(status({ needsSetup: false })), null, "an older service sends no 'required'");
});

test("while an update installs the tools by itself, the setup screen does not ask about them as well", () => {
  const lacking = [tool("speech", { sizeBytes: 400 * mib })];
  assert.equal(setupReason(status({ needsSetup: false, tools: lacking }), false), "tools", "without it: asked once, as before");
  for (const state of ["waiting", "running", "failed", "stopped"] as const) {
    assert.equal(setupReason(status({ needsSetup: false, tools: lacking, required: requiredState({ state }) }), false), null, state);
  }
  assert.equal(setupReason(status({ needsSetup: false, tools: lacking, required: requiredState({ state: "done", remainingBytes: 0 }) }), false), "tools");
  assert.equal(setupReason(status({ needsSetup: false, tools: lacking, required: requiredState({ applies: false }) }), false), "tools");
  assert.equal(setupReason(status({ needsSetup: true, tools: lacking, required: requiredState({ applies: false }) }), false), "first-run", "a new install still gets its screen");
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
