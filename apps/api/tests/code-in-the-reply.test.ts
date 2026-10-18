import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Code asked for in the reply is written in the reply, not run. Live on
// 2026-10-18, with machine access on, "Write a one-line Python function that
// reverses a string." on the 3B ran the definition as a shell command and
// answered that the function "is not recognized as a valid command"; another
// run looped through tools until it gave up. "python" had put the shell on
// offer, as it should for "what version of python is installed?".

process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "trhai-code-reply-"));
const { asksForCodeInTheReply } = await import("../src/services/actionIntent.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { armCommands, disarmCommands } = await import("../src/services/commandRunner.js");
const { fakeEngine } = await import("./helpers/fakeEngine.js");

test("a request for code to read is told from a request to run something", () => {
  for (const code of [
    "Write a one-line Python function that reverses a string.",
    "write a python script that prints hello",
    "Show me a bash one-liner to count lines in a file",
    "give me a regex that matches an email address",
    "write a powershell command that lists my running services",
    "Can you write me a short SQL query that counts orders per customer?",
    "make a JavaScript class for a stack"
  ]) assert.equal(asksForCodeInTheReply(code), true, code);

  for (const other of [
    "run python --version",
    "what version of python is installed?",
    "is anything listening on port 4000?",
    "write a file called hello.py that prints hello",
    "write a python script that prints hello and run it",
    "write a script to back up my notes, then run it",
    "explain what this python code does: print(1)",
    "what is the capital of Australia?"
  ]) assert.equal(asksForCodeInTheReply(other), false, other);
});

test("with machine access on, the shell is offered to run something, not to write code", async () => {
  const engine = await fakeEngine({ reply: { message: { content: "def reverse(s): return s[::-1]" } } });
  armCommands();
  try {
    const offered = async (question: string) => {
      const before = engine.chats.length;
      await runAgent({ baseUrl: engine.baseUrl, model: "llama3.2", modelFromEnv: true, timeoutMs: 4000 }, question, { memories: [], knowledge: [] });
      return (engine.chats[before]?.tools ?? []).map((tool) => tool.function.name);
    };
    assert.equal((await offered("Write a one-line Python function that reverses a string.")).includes("run_command"), false);
    assert.equal((await offered("what version of python is installed?")).includes("run_command"), true,
      "a question the machine answers still gets the shell");
  } finally {
    disarmCommands();
    await engine.close();
  }
});
