import test from "node:test";
import assert from "node:assert/strict";
import { updateAction } from "../src/lib/desktopUpdates.js";

// What the update button offers, from the installed app's updater.

test("outside the installed app, or where it cannot update itself, the button is the download link", () => {
  assert.deepEqual(updateAction(null, "0.1.6"), { kind: "link" });
  assert.deepEqual(updateAction({ state: "unsupported", reason: "portable" }, "0.1.6"), { kind: "link" });
});

test("in the installed app it downloads, shows progress, then restarts into the update", () => {
  assert.deepEqual(updateAction({ state: "idle" }, "0.1.6"), { kind: "download", label: "Download and install v0.1.6", note: null });
  assert.deepEqual(updateAction({ state: "available", version: "0.1.6" }, "0.1.6"), { kind: "download", label: "Download and install v0.1.6", note: null });
  assert.deepEqual(updateAction({ state: "checking" }, "0.1.6"), { kind: "busy", label: "Checking…" });
  assert.deepEqual(updateAction({ state: "downloading", version: "0.1.6", percent: 41, bytesPerSecond: 1 }, "0.1.6"), { kind: "busy", label: "Downloading… 41%" });
  assert.deepEqual(updateAction({ state: "downloading", version: "0.1.6", percent: 140, bytesPerSecond: 1 }, "0.1.6"), { kind: "busy", label: "Downloading… 100%" });
  assert.deepEqual(updateAction({ state: "downloaded", version: "0.1.6" }, "0.1.6"), { kind: "restart", label: "Restart to update to v0.1.6" });
});

test("a failure says why and offers to try again", () => {
  assert.deepEqual(updateAction({ state: "error", message: "The release page could not be reached." }, "0.1.6"),
    { kind: "download", label: "Try again", note: "The release page could not be reached." });
});
