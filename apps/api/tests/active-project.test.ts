import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "trhai-active-"));
process.env.ASCEND_WORKSPACE = root;
mkdirSync(path.join(root, "calculator"), { recursive: true });
mkdirSync(path.join(root, "tip-calculator"), { recursive: true });

const { activeProject, noteProjectTouched, projectForPath, resetActiveProjects, withinActiveProject } =
  await import("../src/services/activeProject.js");
const { describeWorkspace, summariseWorkspace } =
  await import("../src/services/projectContext.js");

// Which project the conversation is in.
//
// The prompt lists what is in the workspace, so a named project can be found.
// This is what lets "fix the router" work without naming one - the spec's own
// example: "It should not force me to repeatedly explain the same project."

test("a path inside a project names that project", () => {
  assert.equal(projectForPath("calculator/server.js"), "calculator");
  assert.equal(projectForPath("tip-calculator/public/index.html"), "tip-calculator");
});

test("a loose file in the workspace root belongs to no project", () => {
  // Calling the workspace itself "the project" would let any stray file
  // change the answer.
  assert.equal(projectForPath("notes.txt"), null);
});

test("a path outside the workspace names nothing", () => {
  assert.equal(projectForPath("C:/elsewhere/server.js"), null);
  assert.equal(projectForPath(""), null);
});

test("the project follows what the session actually touched", () => {
  resetActiveProjects();
  assert.equal(activeProject("s1"), null, "nothing touched yet means no answer");

  noteProjectTouched("s1", "calculator/server.js");
  assert.equal(activeProject("s1"), "calculator");

  noteProjectTouched("s1", "tip-calculator/server.js");
  assert.equal(activeProject("s1"), "tip-calculator", "the most recent wins");
});

test("sessions do not see each other's project", () => {
  resetActiveProjects();
  noteProjectTouched("a", "calculator/server.js");
  noteProjectTouched("b", "tip-calculator/server.js");
  assert.equal(activeProject("a"), "calculator");
  assert.equal(activeProject("b"), "tip-calculator");
});

test("a touch outside any project leaves the current one alone", () => {
  resetActiveProjects();
  noteProjectTouched("s", "calculator/server.js");
  noteProjectTouched("s", "loose.txt");
  assert.equal(activeProject("s"), "calculator", "a stray file must not clear it");
});

test("the prompt says which project, and only when one is known", () => {
  const summary = summariseWorkspace();
  assert.doesNotMatch(describeWorkspace(summary, null), /currently working in/);
  assert.match(describeWorkspace(summary, "calculator"), /currently working in calculator/);
});

// A bare filename means the project the session is working in.
//
// The prompt says which project is current and the model does not reliably act
// on it: asked to read the smoke test right after reading
// calculator/server.js, it called read_file on a name of its own invention.
// Telling it more firmly is not a fix - a model that ignores one sentence will
// ignore two - so the resolution is mechanical.

test("a bare name resolves inside the current project", () => {
  resetActiveProjects();
  noteProjectTouched("s", "calculator/server.js");
  assert.equal(withinActiveProject("s", "smoke.js"), "calculator/smoke.js");
});

test("a path that already says where it lives is left alone", () => {
  resetActiveProjects();
  noteProjectTouched("s", "calculator/server.js");
  assert.equal(withinActiveProject("s", "tip-calculator/smoke.js"), null);
  assert.equal(withinActiveProject("s", "D:/elsewhere/smoke.js"), null);
});

test("with no current project there is nothing to resolve against", () => {
  resetActiveProjects();
  assert.equal(withinActiveProject("s", "smoke.js"), null);
  assert.equal(withinActiveProject(undefined, "smoke.js"), null);
});
