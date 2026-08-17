import test from "node:test";
import assert from "node:assert/strict";
import { getServiceSpawnOptions } from "../src/launcher.js";

test("a Windows service never opens its own console", () => {
  // `detached` becomes CREATE_NEW_CONSOLE on Windows, which beats windowsHide:
  // with it set, opening the app flashed up three console windows, one per
  // service. This is the whole reason the option is computed rather than
  // written inline.
  const options = getServiceSpawnOptions("win32");

  assert.equal(options.detached, false);
  assert.equal(options.windowsHide, true);
});

test("elsewhere a service is detached into its own process group", () => {
  // Which is what lets it be signalled as a group when the app quits.
  const options = getServiceSpawnOptions("linux");

  assert.equal(options.detached, true);
  assert.equal(getServiceSpawnOptions("darwin").detached, true);
});

test("windowsHide is set on every platform", () => {
  // A no-op off Windows. Left conditional, it invited being dropped from the
  // one branch that actually needs it.
  for (const platform of ["win32", "linux", "darwin"]) {
    assert.equal(getServiceSpawnOptions(platform).windowsHide, true, platform);
  }
});

test("a service never inherits a pipe it would block on", () => {
  // Nothing reads these streams; an inherited pipe fills and stalls the child.
  assert.equal(getServiceSpawnOptions("win32").stdio, "ignore");
});
