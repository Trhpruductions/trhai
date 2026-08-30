import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, clarificationFor, isExplanatoryQuestion } from "../src/services/actionIntent.js";

// The classifier that decides whether prose alone would be a failure.
//
// Every case here is one of two mistakes: treating a question as an order, or
// treating an order as a question. The second is the bug this exists for - it
// is how "edit greet.js" got answered with "Got it, I'll keep that in mind".

test("reading a named file is an action", () => {
  const verdict = classifyIntent("Read D:\\example\\notes.txt");
  assert.equal(verdict.action, true);
  assert.equal(verdict.kind, "read");
  assert.equal(verdict.hasTarget, true);
  assert.ok(verdict.expects.includes("read_file"));
});

test("listing a named folder is an action", () => {
  const verdict = classifyIntent("List files in D:\\example");
  assert.equal(verdict.action, true);
  assert.equal(verdict.kind, "read");
});

test("editing a named file is a write action", () => {
  const verdict = classifyIntent("Edit D:\\example\\notes.txt and change hello to hi");
  assert.equal(verdict.action, true);
  assert.equal(verdict.kind, "write");
  assert.ok(verdict.expects.includes("edit_file"));
});

test("running the project's tests is a check", () => {
  const verdict = classifyIntent("Run npm test in this project");
  assert.equal(verdict.action, true);
  assert.equal(verdict.kind, "check");
});

test("asking for an app to be built is a generate action", () => {
  const verdict = classifyIntent("Build a simple task app");
  assert.equal(verdict.action, true);
  assert.equal(verdict.kind, "generate");
  assert.ok(verdict.expects.includes("build_app"));
});

test("running an arbitrary command is an execute action", () => {
  const verdict = classifyIntent("Run node --version");
  assert.equal(verdict.action, true);
  assert.equal(verdict.kind, "execute");
});

test("a question about a file stays a question", () => {
  // Contains "file". Must not become a read action.
  assert.equal(classifyIntent("What does this file do?").action, false);
});

test("a request to explain something stays a question", () => {
  assert.equal(classifyIntent("Explain TypeScript generics").action, false);
});

test("an explanatory opener wins over a verb later in the sentence", () => {
  // The case that makes opener-checking worth doing first: this contains
  // "build a", which is otherwise a generate action.
  assert.equal(classifyIntent("Explain how to build a task app").action, false);
  assert.equal(classifyIntent("How do I edit package.json?").action, false);
  assert.equal(classifyIntent("Why did the build fail?").action, false);
});

test("an action verb with nothing to act on is still an action, without a target", () => {
  // "edit the file" is an order. It just cannot be carried out yet, which is a
  // reason to ask one question rather than to retry.
  const verdict = classifyIntent("Edit the file and fix the bug");
  assert.equal(verdict.action, true);
  assert.equal(verdict.hasTarget, false);
});

test("conversational uses of action verbs are not orders", () => {
  // "add" and "change" are ordinary English. Without a file to act on, these
  // are talk, and forcing a tool call on them would break normal conversation.
  assert.equal(classifyIntent("add that to the plan we discussed").action, false);
  assert.equal(classifyIntent("I want to change my approach").action, false);
});

test("a bare filename counts as a target", () => {
  const verdict = classifyIntent("read server.js");
  assert.equal(verdict.action, true);
  assert.equal(verdict.hasTarget, true);
});

test("an empty message is not an action", () => {
  assert.equal(classifyIntent("").action, false);
  assert.equal(classifyIntent("   ").action, false);
});

test("classification does not depend on capitalisation", () => {
  assert.equal(classifyIntent("READ D:\\example\\notes.txt").action, true);
  assert.equal(classifyIntent("WHAT DOES THIS FILE DO?").action, false);
});

test("ordinary English uses of 'run' are not commands", () => {
  // execute names its own target, so it cannot demand a file the way edit does.
  // That leaves the everyday senses of the word to exclude by hand.
  assert.equal(classifyIntent("run me through what you did").action, false);
  assert.equal(classifyIntent("that will pay off in the long run").action, false);
});

// Phrasing that reads like an action but is conversation.

test("action words in conversation do not become orders", () => {
  // Each of these contains a verb from the action list. None is an instruction.
  assert.equal(classifyIntent("Can you run me through this code?").action, false);
  assert.equal(classifyIntent("What command should I run?").action, false);
  assert.equal(classifyIntent("Explain how a build works").action, false);
  assert.equal(classifyIntent("What does this file do?").action, false);
});

// Genuine instructions that must still be caught.

test("genuine instructions classify correctly", () => {
  const run = classifyIntent("Run node --version");
  assert.equal(run.action, true);
  assert.equal(run.kind, "execute");
  assert.equal(run.hasTarget, true, "the command is its own target");

  const test1 = classifyIntent("Run npm test");
  assert.equal(test1.action, true);
  assert.equal(test1.kind, "check");
  assert.equal(test1.hasTarget, true, "a named script says where by saying what");

  const edit = classifyIntent("Open and edit D:\example\file.txt");
  assert.equal(edit.action, true);
  assert.equal(edit.hasTarget, true);

  const list = classifyIntent("List the files in this project");
  assert.equal(list.action, true);
  assert.equal(list.kind, "read");
});

// Per-kind targeting: what counts as "named it" differs by the work.

test("a command without a command asks for one, not for a file", () => {
  const verdict = classifyIntent("Run the script for me");
  assert.equal(verdict.action, true);
  assert.equal(verdict.kind, "execute");
  assert.equal(verdict.hasTarget, false);
  assert.match(clarificationFor("execute"), /which command/i);
});

test("a check without a project asks which project", () => {
  const verdict = classifyIntent("Run the tests");
  assert.equal(verdict.action, true);
  assert.equal(verdict.kind, "check");
  assert.equal(verdict.hasTarget, false);
  assert.match(clarificationFor("check"), /which project/i);
});

test("a described app is complete enough to build", () => {
  // Interrogating someone who has already said what they want is its own
  // failure, so generate is deliberately the loosest.
  assert.equal(classifyIntent("Build me a task app").hasTarget, true);
  assert.equal(classifyIntent("Build me an app").hasTarget, false);
});

test("each kind asks a question suited to its work", () => {
  assert.match(clarificationFor("read"), /file or folder/i);
  assert.match(clarificationFor("write"), /what should it say/i);
  assert.match(clarificationFor("generate"), /what should the app do/i);
});

// Questions that cannot be answered without opening the file they name.

test("asking what a named file contains is a read, not a question", () => {
  // Found by sweeping realistic phrasings: this opens with "what", so the
  // explanatory rule called it a question and let the model answer about a
  // real file it had never read - the exact failure this classifier exists
  // to prevent.
  for (const message of [
    "what does D:/trhai/package.json contain",
    "what's in D:/trhai/package.json",
    "what is inside server.js"
  ]) {
    const verdict = classifyIntent(message);
    assert.equal(verdict.action, true, `should be an action: ${message}`);
    assert.equal(verdict.kind, "read");
    assert.equal(verdict.hasTarget, true);
  }
});

test("a how-to question that names a file stays a question", () => {
  // The narrow part. This names package.json too, but answering it does not
  // require reading one - it asks about procedure.
  assert.equal(classifyIntent("How do I edit package.json?").action, false);
  assert.equal(classifyIntent("why does server.js need that import").action, false);
});

test("an order with a described but unnamed file earns one question", () => {
  // "the old log file" - two words between the determiner and the noun. Read
  // as conversation before, so nothing was asked and nothing was done.
  const verdict = classifyIntent("delete the old log file");
  assert.equal(verdict.action, true);
  assert.equal(verdict.kind, "write");
  assert.equal(verdict.hasTarget, false);
});

// What the model is allowed to reach for, decided from the request.

test("an abstract question is recognised as explanatory", () => {
  // The live failure: this exact message reached build_app and scaffolded a
  // five-file "Javascript App" into the workspace. The user asked for an
  // explanation and got a directory.
  for (const question of [
    "explain how promises work in javascript",
    "how do i add a guard to a function",
    "what is a closure",
    "why does async/await need a try block",
    "compare rest and graphql"
  ]) {
    assert.equal(isExplanatoryQuestion(question), true, `should restrain: ${question}`);
  }
});

test("a question about a real file is not restrained", () => {
  // It names something concrete and may well need to open it.
  assert.equal(isExplanatoryQuestion("what is in D:/trhai/package.json"), false);
  assert.equal(isExplanatoryQuestion("explain what app.ts does"), false);
});

test("a request to build something is not a question", () => {
  // The case that must keep working. These name no verb the classifier tracks
  // in one instance and are plainly orders in the others.
  for (const request of [
    "build me a task tracker",
    "I need a pomodoro timer app",
    "make a snake game"
  ]) {
    assert.equal(isExplanatoryQuestion(request), false, `must stay buildable: ${request}`);
  }
});
