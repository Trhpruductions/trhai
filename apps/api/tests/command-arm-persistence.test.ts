import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Machine access is on by default and the decision persists.
//
// It used to be off until armed, for thirty minutes at a time. That treated
// access as an exception granted for a task, which was the wrong model of how
// this app is used: it is one person's assistant on their own machine, and an
// assistant that cannot reach their files until they flip a switch - and
// forgets again while they are still working - is one they have to manage
// rather than use.
//
// What has to hold now: on unless turned off, and every decision survives a
// restart, including "off".

const directory = mkdtempSync(path.join(tmpdir(), "trhai-access-"));
const accessFile = path.join(directory, "command-arm.json");
process.env.TRHAI_ARM_FILE = accessFile;

const runner = await import("../src/services/commandRunner.js");

test("with nothing decided, the machine is reachable", () => {
  runner.resetCommandRunner();
  assert.equal(runner.commandsArmed(), true);
});

test("turning it off sticks, and is written down", () => {
  // "Off" has to persist as firmly as "on", or turning it off would be undone
  // by the next restart.
  runner.disarmCommands();
  assert.equal(runner.commandsArmed(), false);
  assert.equal(existsSync(accessFile), true);

  const stored = JSON.parse(readFileSync(accessFile, "utf8")) as { enabled: boolean };
  assert.equal(stored.enabled, false);
});

test("a stored refusal survives a restart", () => {
  writeFileSync(accessFile, JSON.stringify({
    enabled: false,
    decidedAt: new Date().toISOString()
  }), "utf8");

  runner.resetCommandRunner({ rereadFromDisk: true });
  assert.equal(runner.commandsArmed(), false, "a restart must not quietly re-enable access");
});

test("turning it back on sticks too", () => {
  runner.armCommands();
  assert.equal(runner.commandsArmed(), true);
  assert.equal(runner.armedUntil(), null, "a permanent grant has no expiry to report");
});

test("a bounded grant can still be made, and lapses", () => {
  // Nothing calls this now, but a time-limited grant is a genuinely different
  // thing from a permanent one and deleting it would remove a capability.
  const now = new Date();
  runner.armCommandsFor(1000, now);
  assert.equal(runner.commandsArmed(new Date(now.getTime() + 500)), true);
  assert.equal(runner.armedUntil() !== null, true);

  // Past the window it lapses - back to the default, not to "off". A window
  // running out is the absence of a decision, not a decision to stay closed.
  assert.equal(runner.commandsArmed(new Date(now.getTime() + 2000)), true);
  assert.equal(runner.armedUntil(), null, "the lapsed window is cleared");
});

test("a grant file from the previous version is honoured, not discarded", () => {
  // Upgrading must not revoke access somebody had deliberately granted.
  writeFileSync(accessFile, JSON.stringify({
    armedUntil: Date.now() + 60_000,
    armedAt: new Date().toISOString()
  }), "utf8");

  runner.resetCommandRunner({ rereadFromDisk: true });
  assert.equal(runner.commandsArmed(), true);
});

test("an unreadable file leaves the default in place", () => {
  writeFileSync(accessFile, "{ not json", "utf8");
  runner.resetCommandRunner({ rereadFromDisk: true });
  assert.equal(runner.commandsArmed(), true);
});

test("resetting stops anything reading the decision from disk", () => {
  // Otherwise a test run inherits whatever the developer set on their own
  // machine, and a test about access passes or fails depending on whether
  // somebody used the app that afternoon.
  runner.disarmCommands();
  runner.resetCommandRunner();
  assert.equal(runner.commandsArmed(), true);
});
