import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "trhai-projctx-"));
process.env.ASCEND_WORKSPACE = root;

const { describeWorkspace, explainMiss, namedProjectLimit, suggestPaths, summariseWorkspace } =
  await import("../src/services/projectContext.js");

// Telling the model where the work is, instead of letting it guess.
//
// Live failure: asked to list "the calculator folder", the model called
// list_files on D:/projects/calculator - a directory that has never existed on
// this machine - and then asked the user for a full path. The tools were fine:
// read_file("calculator/server.js") worked first time. Only the knowledge of
// what to pass them was missing, because the prompt says "the workspace" a
// dozen times and never once says where that is.

function makeProject(name: string) {
  mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, name, "server.js"), "// x\n");
}

test("the description names the workspace root", () => {
  const text = describeWorkspace(summariseWorkspace());
  assert.ok(text.includes(root), "the model cannot use a path it is never given");
});

test("it warns off the paths the model actually invented", () => {
  // Named outright rather than described, because these are the two it reached
  // for unprompted and a general "do not guess" did not stop it.
  const text = describeWorkspace(summariseWorkspace());
  assert.match(text, /D:\/projects/);
  assert.match(text, /C:\/Users/);
});

test("projects are listed by name", () => {
  makeProject("calculator");
  makeProject("tip-calculator");

  const summary = summariseWorkspace();
  assert.ok(summary.projects.includes("calculator"));
  assert.equal(summary.total, 2);

  const text = describeWorkspace(summary);
  assert.match(text, /- calculator/);
  assert.match(text, /calculator\/server\.js/, "it should show what a real path looks like");
});

test("a crowded workspace is capped, and says how many it left out", () => {
  // Sixty-odd directories would crowd out the instructions that matter, so the
  // recent ones are named and the rest are counted rather than dropped in
  // silence - a model told about 12 of 60 should know 48 exist.
  for (let i = 0; i < namedProjectLimit + 6; i += 1) makeProject(`app-${i}`);

  const summary = summariseWorkspace();
  assert.equal(summary.projects.length, namedProjectLimit);
  assert.ok(summary.total > namedProjectLimit);

  assert.match(describeWorkspace(summary), /older ones not listed/);
});

test("an empty workspace still states the root and claims no projects", () => {
  const empty = { root: "D:/nowhere", commandCwd: "C:/Users/someone", projects: [], total: 0 };
  const text = describeWorkspace(empty);
  assert.ok(text.includes("D:/nowhere"));
  assert.doesNotMatch(text, /Projects in it right now/);
});

test("it states where commands run, which is not the workspace", () => {
  // The other half of the same failure. read_file worked, then the model ran
  // `node index.js` and got "Cannot find module C:\Users\hankh\index.js" -
  // run_command starts in the home directory and nothing had said so.
  const summary = summariseWorkspace();
  const text = describeWorkspace(summary);

  assert.ok(text.includes(summary.commandCwd), "the model must be told where commands start");
  assert.match(text, /does NOT start in the workspace/);
  assert.match(text, /cd .+ && npm start/, "and shown how to run inside a project");
});

// A miss that names what does exist.
//
// "There is no file at calculator/public/server.js" is true and a dead end.
// Live: the model guessed the public/ subdirectory, was told no, said it would
// try the main directory instead, and then stopped.

test("a wrong directory is answered with the right one", () => {
  const found = suggestPaths("calculator/public/server.js");
  assert.ok(found.some((p) => p.endsWith("calculator/server.js")), `got ${found.join(", ")}`);
});

test("the path already tried is not offered back", () => {
  assert.ok(!suggestPaths("calculator/server.js").includes("calculator/server.js"));
});

test("a name that exists nowhere suggests nothing", () => {
  assert.deepEqual(suggestPaths("calculator/nothing-like-this.xyz"), []);
});

test("the explanation keeps the original reason and adds the real path", () => {
  const said = explainMiss('There is no file at "calculator/public/server.js".',
    "calculator/public/server.js");
  assert.match(said, /There is no file at/, "the original truth survives");
  assert.match(said, /calculator\/server\.js/);
});

test("with nothing to suggest, the reason is returned untouched", () => {
  const reason = 'There is no file at "nope/absent.xyz".';
  assert.equal(explainMiss(reason, "nope/absent.xyz"), reason);
});
