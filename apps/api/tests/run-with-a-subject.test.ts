import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A workspace of its own: a turn that reaches the model is offered tools.
process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "trhai-run-"));

const { classifyIntent, clarificationFor } = await import("../src/services/actionIntent.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { fakeEngine } = await import("./helpers/fakeEngine.js");

// "run" with a subject in front of it is not an order.
//
// Found live on 4 October, on Qwen3: "A farmer has 17 sheep and all but 9 run
// away. How many are left? Answer in one sentence." It thought for thirteen
// seconds and answered "The farmer has 9 sheep left." The reply shown was
// "Which command should I run? Give me the exact command." The request had
// been filed as an order to run a command; no command was run, so the answer
// was thrown away and the question put in its place.
//
// Any " run " did it. Eleven of fourteen ordinary sentences tried were filed
// the same way.

const riddle = "A farmer has 17 sheep and all but 9 run away. How many are left? Answer in one sentence.";

test("something that runs is not an order to run something", () => {
  for (const said of [
    riddle,
    "Two trains run toward each other at 60 mph from 120 miles apart. When do they meet?",
    "The buses run every 10 minutes. The last one left at 3:05. When is the next?",
    "I run a small bakery and need a slogan for it",
    "My kids run around all day, suggest a quiet game",
    "Rivers run to the sea. Write a haiku about that.",
    "If I run 5 km a day for a week, how far is that in total?",
    "The tests run fine on my machine but fail in CI, any idea why?",
    "Dogs that run away usually come back. True or false?",
    "Some people run for office, others run from it. Thoughts?",
    // At the head of a sentence, and still nothing to run.
    "Run away with me is a song by whom?"
  ]) {
    const verdict = classifyIntent(said);
    assert.equal(verdict.action, false, `${said} -> ${JSON.stringify(verdict)}`);
  }
});

test("an order to run something is still one, wherever the sentence puts it", () => {
  for (const order of [
    "run npm test",
    "Run node --version",
    "please run the build",
    "can you run the tests",
    "could you quickly run the linter",
    "now run it",
    "then run npm install",
    "I want you to run the migration",
    "go ahead and run it",
    "ok, run the script",
    "we should run the tests",
    "you can run it now",
    "please run it",
    "could you quickly run it",
    "let's run it",
    "just run the installer",
    "you must run the migration first",
    // An ordinary "run" earlier in the message does not hide the order after it.
    "My dogs run away a lot. Anyway, run npm test"
  ]) {
    const verdict = classifyIntent(order);
    assert.equal(verdict.action, true, order);
    assert.ok(verdict.kind === "execute" || verdict.kind === "check", `${order} -> ${verdict.kind}`);
  }
  // And the other words that order something run are untouched by a "run" that does not.
  const install = classifyIntent("the tests run fine, so install the package");
  assert.equal(install.kind, "execute");
  assert.match(install.reason, /install/);
  // Told not to is still not an order.
  assert.equal(classifyIntent("don't run it").action, false);
});

const config = (baseUrl: string) => ({ baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 });
const context = { memories: [], knowledge: [] };

test("the answer to the riddle is what the user reads", async () => {
  const engine = await fakeEngine({ reply: { message: { content: "The farmer has 9 sheep left." } } });
  try {
    const result = await runAgent(config(engine.baseUrl), riddle, context);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) return;
    assert.equal(result.text, "The farmer has 9 sheep left.");
    assert.equal(engine.chats.length, 1, "asked once: nothing pressed it to run a command");

    // The control: an order that names no command, answered in words, is
    // still asked which command - the question the riddle was getting.
    const order = await runAgent(config(engine.baseUrl), "now run it", context);
    assert.equal(order.ok, true);
    if (!order.ok) return;
    assert.equal(order.text, clarificationFor("execute"));
  } finally {
    await engine.close();
  }
});
