import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { fakeEngine, fakeWindow } from "./helpers/fakeEngine.js";

// A model that does not stop, end to end. On 2 October qwen2.5:3b, sent the
// turn below, wrote past 13,000 tokens until the 180 s timeout gave up on it,
// and the task was recorded as "No local model was available to run this".
// Here a stand-in engine does what the model did - or finishes, or never answers -
// and the checks read what the Task center is then told, through
// /v1/agent-tasks and /v1/agent-tasks/history. Every store the route touches
// is pointed at a temporary directory before server.js loads, as in
// assist-agent.test.ts.
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-reply-limit-"));
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASSIST_TASK_FILE = path.join(dataDir, "tasks.json");
process.env.ASSIST_TASK_HISTORY_FILE = path.join(dataDir, "task-history.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * The turn from 2 October, with the model it named - in the spelling it had
 * then, when the models were Ollama's. The engine's name for it is qwen2.5-3b.
 */
const checklist = { mode: "general", model: "qwen2.5:3b", message: "Write a short checklist, eight items, for reviewing a pull request." };
/** Where the model got to before it was cut off, or the whole of it when it finishes. */
const written = "1. Read the description.\n2. Run the tests.\n3. Read the diff.\n4. Run the tests.\n";

type Ending = "stop" | "length" | "never";

/**
 * A stand-in engine with two models. Every chat request is recorded and
 * answered with `written`, ending as `ending` says: "stop" is a model that
 * finished, "length" one the reply limit cut off, "never" one that is still
 * going when the request gives up. Streamed when the request asks for a
 * stream, the way the web client's route is answered.
 */
function standIn(ending: Ending, installed = ["qwen2.5-3b", "llama3.2-3b"]) {
  return fakeEngine({
    models: installed,
    reply: () => (ending === "never" ? "hang" : { message: { content: written }, done_reason: ending })
  });
}

/**
 * One turn against `engine`, then what the Task center reads for that
 * session: the current task and the history. `stream` sends it the way the
 * web client does.
 */
async function turn(
  engine: { baseUrl: string },
  sessionId: string,
  options: { stream?: boolean; body?: Record<string, unknown> } = {}
) {
  const previous = process.env.TRHAI_ENGINE_URL;
  process.env.TRHAI_ENGINE_URL = engine.baseUrl;
  const app = createApp().listen(0, "127.0.0.1");
  await once(app, "listening");
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/v1/assist${options.stream ? "/stream" : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...checklist, sessionId, ...options.body })
    });
    assert.equal(response.status, 200);
    let reply: string;
    if (options.stream) {
      const events = await response.text();
      const done = /event: done\ndata: (.+)/.exec(events)?.[1];
      assert.ok(done, `the stream ended without a done event:\n${events}`);
      reply = (JSON.parse(done) as { assistantMessage: string }).assistantMessage;
    } else {
      reply = ((await response.json()) as { data: { assistantMessage: string } }).data.assistantMessage;
    }
    const current = (await (await fetch(`${base}/v1/agent-tasks?sessionId=${sessionId}`)).json()) as {
      data: { tasks: Array<{ status: string; error?: string; running: boolean }> };
    };
    const history = (await (await fetch(`${base}/v1/agent-tasks/history?sessionId=${sessionId}`)).json()) as {
      data: { history: Array<{ status: string; error?: string; result?: string }> };
    };
    assert.equal(current.data.tasks.length, 1, "the turn reached the agent and was recorded as a task");
    assert.equal(history.data.history.length, 1, "and was kept in the history when it ended");
    return { reply, task: current.data.tasks[0], finished: history.data.history[0] };
  } finally {
    if (previous === undefined) delete process.env.TRHAI_ENGINE_URL;
    else process.env.TRHAI_ENGINE_URL = previous;
    await new Promise<void>((resolve) => app.close(() => resolve()));
  }
}

test("every request carries the reply limit, and a reply that finishes is the answer", async () => {
  // The control for the tests below: the same stand-in, the same words, and
  // only the ending differs.
  const engine = await standIn("stop");
  try {
    const { reply, task, finished } = await turn(engine, "limit-finishes");
    assert.ok(engine.chats.length > 0, "the request reached the model");
    for (const chat of engine.chats) {
      assert.equal(chat.max_tokens, fakeWindow, "no reply may run past one window: the one the engine gave the model");
    }
    assert.match(reply, /Read the description/);
    assert.equal(task.status, "succeeded");
    assert.equal(task.error, undefined);
    assert.equal(finished.status, "succeeded");
  } finally {
    await engine.close();
  }
});

test("a reply cut off at the length limit is recorded as too long - not as the answer, and not as no model", async () => {
  const engine = await standIn("length");
  try {
    const { reply, task, finished } = await turn(engine, "limit-runs-on");
    // Asked once, of the model the turn named: a reply that ran on is not
    // handed to the next installed model, which would start it over.
    assert.deepEqual(engine.chats.map((chat) => chat.model), ["qwen2.5-3b"]);
    assert.doesNotMatch(reply, /Read the description|Run the tests/, "none of the cut-off reply is shown as the answer");

    const tooLong = "The reply from qwen2.5-3b ran past the length limit (16,384 tokens) without finishing.";
    assert.equal(task.status, "failed", "a model took it and came back without an answer");
    assert.equal(task.error, tooLong);
    assert.equal(task.running, false);
    assert.equal(finished.status, "failed");
    assert.equal(finished.error, tooLong);
  } finally {
    await engine.close();
  }
});

test("the same, streamed - the way the web client asks", async () => {
  const engine = await standIn("length");
  try {
    const { reply, task, finished } = await turn(engine, "limit-runs-on-streamed", { stream: true });
    assert.deepEqual(engine.chats.map((chat) => chat.stream), [true], "the streamed path, which reads the reason from the last frame");
    assert.doesNotMatch(reply, /Read the description|Run the tests/, "the done event does not carry the cut-off reply as the answer");
    assert.equal(task.status, "failed");
    assert.match(task.error ?? "", /^The reply from qwen2\.5-3b ran past the length limit \(16,384 tokens\)/);
    assert.equal(finished.error, task.error);
  } finally {
    await engine.close();
  }
});

test("a model that does not reply in time is recorded as that, with the time it was given", async () => {
  const engine = await standIn("never");
  const previousTimeout = process.env.TRHAI_MODEL_TIMEOUT_MS;
  process.env.TRHAI_MODEL_TIMEOUT_MS = "1000";
  try {
    const { task, finished } = await turn(engine, "limit-times-out");
    // The model was asked: the time ran out on the reply, not on reaching it.
    assert.deepEqual(engine.chats.map((chat) => chat.model), ["qwen2.5-3b"]);
    assert.equal(task.status, "failed");
    assert.equal(task.error, "qwen2.5-3b did not reply within 1 s.");
    assert.doesNotMatch(task.error ?? "", /no local model|unavailable/i);
    assert.equal(finished.error, task.error);
  } finally {
    if (previousTimeout === undefined) delete process.env.TRHAI_MODEL_TIMEOUT_MS;
    else process.env.TRHAI_MODEL_TIMEOUT_MS = previousTimeout;
    await engine.close();
  }
});

test("no model installed is recorded as that, and as blocked rather than failed", async () => {
  // The one case the old words were true of - and still worded from what
  // the engine said, rather than a sentence fixed in advance.
  const engine = await standIn("stop", []);
  try {
    const { task, finished } = await turn(engine, "limit-no-model");
    assert.equal(engine.chats.length, 0, "there was nothing to ask");
    assert.equal(task.status, "blocked", "the work never ran");
    assert.match(task.error ?? "", /^The model engine is running at http:\/\/127\.0\.0\.1:\d+ but has no model to answer with\./);
    assert.equal(finished.status, "blocked");
  } finally {
    await engine.close();
  }
});

test("a request too long for the model's window is said as that, and trying again is not suggested", async () => {
  // What the engine answers when a prompt does not fit its window. Under
  // Ollama the prompt was cut from the front instead, without a word.
  const refuses = (message: string, type: string) => fakeEngine({
    models: ["qwen2.5-3b", "llama3.2-3b"],
    reply: () => ({ status: 400, body: { error: { code: 400, message, type } } })
  });
  const tooLong = await refuses(
    "request (20804 tokens) exceeds the available context size (16384 tokens), try increasing it", "exceed_context_size_error"
  );
  const other = await refuses("something else was wrong with the request", "invalid_request_error");
  const why = "That is more than qwen2.5-3b can take in at once (its window is 16,384 tokens). Ask about less of it at a time.";
  try {
    const { reply, task, finished } = await turn(tooLong, "limit-too-long");
    assert.equal(reply, `I couldn't finish that. ${why}`);
    assert.deepEqual(tooLong.chats.map((chat) => chat.model), ["qwen2.5-3b"], "asked once: the other model would refuse it too");
    assert.equal(task.status, "failed");
    assert.equal(task.error, why);
    assert.equal(finished.error, why);

    // The control: any other refusal may be worth another try, and says so.
    const control = await turn(other, "limit-other-refusal");
    assert.equal(control.reply, "I couldn't finish that. The local model answered 400. Try again in a moment.");
  } finally {
    await tooLong.close();
    await other.close();
  }
});

test("a web search whose model ran on says so, not that there is no model", async () => {
  // orchestrator-generation.test.ts covers the search with no model at all,
  // which still says the model is not available.
  const engine = await standIn("length");
  try {
    const { reply, task } = await turn(engine, "limit-web-search", {
      body: { message: "search the web for the official Node.js release schedule" }
    });
    assert.ok(engine.chats.length > 0, "the request reached the model");
    assert.match(reply, /^I couldn't finish that web search\. The reply from qwen2\.5-3b ran past the length limit/);
    assert.doesNotMatch(reply, /isn't available/);
    assert.equal(task.status, "failed");
  } finally {
    await engine.close();
  }
});
