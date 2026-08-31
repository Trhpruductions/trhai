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

// A URL is not a file.
//
// "fetch https://example.com and tell me what it says" called read_file, which
// resolved the address as a relative path and reported "There is no file at
// D:\Vexora\workspace\example.com". The model then wrote "Did you mean to use
// fetch_url instead?" to the user - it knew, and still did not do it.

test("read_file refuses a URL and names the right tool", async () => {
  const { runTool } = await import("../src/services/agentTools.js");
  for (const url of ["https://example.com", "http://127.0.0.1:4000/health", "ftp://host/x"]) {
    const result = await runTool({ name: "read_file", arguments: { path: url } },
      { memories: [], knowledge: [] });

    assert.equal(result.ok, false, `${url} should be refused`);
    assert.match(result.content, /is a URL, not a file/);
    assert.match(result.content, /fetch_url/, "the refusal must name the move to make");
  }
});

test("an ordinary path is not mistaken for a URL", async () => {
  const { runTool } = await import("../src/services/agentTools.js");
  for (const p of ["notes.txt", "src/server.js", "D:/work/app.js", "C:\work\app.js"]) {
    const result = await runTool({ name: "read_file", arguments: { path: p } },
      { memories: [], knowledge: [] });
    // It may well not exist; what matters is that it was treated as a path.
    assert.doesNotMatch(result.content, /is a URL/, `${p} was called a URL`);
  }
});
