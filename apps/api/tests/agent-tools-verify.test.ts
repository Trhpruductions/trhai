import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "trhai-verify-"));
const { verifiedDetail } = await import("../src/services/agentTools.js");

test("a silent pass is reported as a pass, not as nothing", () => {
  // buildVerification's summarize() returns "no output" when a smoke test
  // exits 0 without printing anything - and the exit code is what decides the
  // verdict, so that is a pass. The build reply rendered it verbatim as
  // "verified it: no output", which reads like the verification did nothing.
  // A countdown timer that genuinely built, served HTTP 200 and rendered its
  // own UI was described in words that gave no reason to believe any of it.
  const said = verifiedDetail("no output");
  assert.match(said, /passed/);
  assert.doesNotMatch(said, /^no output$/);
});

test("anything the test actually printed is shown verbatim", () => {
  // The wording only replaces the empty case. What the checks said is always
  // the better thing to show.
  assert.equal(verifiedDetail("25/25 checks passed"), "25/25 checks passed");
  assert.equal(verifiedDetail("1/3 checks passed"), "1/3 checks passed");
});
