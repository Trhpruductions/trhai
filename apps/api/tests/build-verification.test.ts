import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// build_app used to write files and report success on the strength of the
// write succeeding, never on the strength of the thing actually running.
// These exercise verifyBuiltProject directly, against real smoke.js fixtures
// with known outcomes, rather than the real project generator — the generator
// is expected to always produce a passing project, so forcing it to fail
// would mean lying to it rather than testing the three real outcomes: passed,
// failed, and could not be run at all.

const workspace = mkdtempSync(path.join(tmpdir(), "ascend-verify-"));
process.env.ASCEND_WORKSPACE = workspace;

const { verifyBuiltProject } = await import("../src/services/buildVerification.js");

function project(folder: string, smokeSource: string): void {
  const dir = path.join(workspace, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "smoke.js"), smokeSource, "utf8");
}

test("a passing smoke test is reported as passed, with its check count", async () => {
  project("passing", [
    "console.log('  ok   first check');",
    "console.log('  ok   second check');",
    "process.exit(0);"
  ].join("\n"));

  const result = await verifyBuiltProject("passing");

  assert.equal(result.ran, true);
  if (!result.ran) return;
  assert.equal(result.passed, true);
  assert.match(result.output, /2\/2 checks passed/);
});

test("a failing smoke test is reported as failed, not as inconclusive", async () => {
  // The distinction that matters most here: this ran to completion and said
  // no, which is a different situation from the check never running at all.
  project("failing", [
    "console.log('  ok   first check');",
    "console.log('  FAIL second check');",
    "process.exit(1);"
  ].join("\n"));

  const result = await verifyBuiltProject("failing");

  assert.equal(result.ran, true);
  if (!result.ran) return;
  assert.equal(result.passed, false);
  assert.match(result.output, /1\/2 checks passed/);
  assert.match(result.output, /failed: FAIL second check/);
});

test("a crash before any check runs is still a failure, not a pass", async () => {
  project("crashes", "throw new Error('boom');");

  const result = await verifyBuiltProject("crashes");

  assert.equal(result.ran, true);
  if (!result.ran) return;
  assert.equal(result.passed, false);
});

test("a folder escaping the workspace is refused, not walked into", async () => {
  // Not reachable through build_app today, since slugify cannot itself
  // produce "..". This asserts the function enforces its own boundary rather
  // than depending on that being true of every future caller.
  const result = await verifyBuiltProject("../../etc");

  assert.equal(result.ran, false);
  if (result.ran) return;
  assert.match(result.reason, /outside the workspace/);
});

test("a missing project directory could not be run, and says so", async () => {
  const result = await verifyBuiltProject("this-folder-does-not-exist");

  assert.equal(result.ran, false);
  if (result.ran) return;
  assert.ok(result.reason.length > 0);
});

test("a smoke test that hangs is stopped rather than left running", async () => {
  // Bounded, so one bad build cannot stall the agent loop indefinitely: the
  // generated server hanging must not become the assistant hanging. A short
  // override keeps this test fast without weakening what it proves.
  project("hangs", "setInterval(() => {}, 1000);");

  const result = await verifyBuiltProject("hangs", 300);

  assert.equal(result.ran, false);
  if (result.ran) return;
  assert.match(result.reason, /did not finish/);
});
