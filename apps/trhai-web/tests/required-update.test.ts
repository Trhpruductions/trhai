import test from "node:test";
import assert from "node:assert/strict";
import { countdownText, requiredUpdateStep, restartCountdownSeconds } from "../src/lib/requiredUpdate.js";
import type { DesktopUpdateStatus } from "../src/lib/desktopUpdates.js";
import type { LatestRelease } from "../src/lib/updates.js";

// What the window does about a release every copy has to move to, at each point the app's own updater can be in.

const release: LatestRelease = { version: "0.1.9", url: "https://example.com/v0.1.9", downloadUrl: null, publishedAt: null, notes: "", required: true };

test("nothing is forced without a required release, or without the installed app's updater", () => {
  assert.deepEqual(requiredUpdateStep(null, { state: "available", version: "0.1.9" }), { kind: "none" });
  assert.deepEqual(requiredUpdateStep(release, null), { kind: "none" }, "a browser has no updater: the ordinary card stays");
  assert.deepEqual(requiredUpdateStep(release, { state: "unsupported", reason: "The portable build does not install updates." }), { kind: "none" });
  assert.deepEqual(requiredUpdateStep(null, null), { kind: "none" });
});

test("from the updater's first look to the restart, each state is one step", () => {
  const steps: Array<[DesktopUpdateStatus, unknown]> = [
    [{ state: "idle" }, { kind: "checking" }],
    [{ state: "checking" }, { kind: "checking" }],
    [{ state: "available", version: "0.1.9" }, { kind: "download" }],
    [{ state: "downloading", version: "0.1.9", percent: 41.6, bytesPerSecond: 1_000_000 }, { kind: "downloading", percent: 42 }],
    [{ state: "downloaded", version: "0.1.9" }, { kind: "restart", version: "0.1.9" }],
    [{ state: "error", message: "The release page could not be reached." }, { kind: "failed", message: "The release page could not be reached." }]
  ];
  for (const [status, expected] of steps) assert.deepEqual(requiredUpdateStep(release, status), expected, status.state);
});

test("a release page that is ahead of the files the updater reads does not trap anyone behind a window", () => {
  assert.deepEqual(requiredUpdateStep(release, { state: "not-available", version: "0.1.8" }), { kind: "none" });
});

test("progress stays between 0 and 100, and a ready update with no version is named from the release", () => {
  assert.deepEqual(requiredUpdateStep(release, { state: "downloading", version: "", percent: -5, bytesPerSecond: 0 }), { kind: "downloading", percent: 0 });
  assert.deepEqual(requiredUpdateStep(release, { state: "downloading", version: "", percent: 250, bytesPerSecond: 0 }), { kind: "downloading", percent: 100 });
  assert.deepEqual(requiredUpdateStep(release, { state: "downloaded", version: "" }), { kind: "restart", version: "0.1.9" });
});

test("the restart waits two minutes, and the time left reads as minutes and seconds", () => {
  assert.equal(restartCountdownSeconds, 120);
  assert.equal(countdownText(120), "2:00");
  assert.equal(countdownText(65), "1:05");
  assert.equal(countdownText(9), "0:09");
  assert.equal(countdownText(0), "0:00");
  assert.equal(countdownText(-3), "0:00");
  assert.equal(countdownText(59.9), "0:59");
});
