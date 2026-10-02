import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

// A model that does not stop, end to end. On 2 October qwen2.5:3b, sent the
// turn below, wrote past 13,000 tokens until the 180 s timeout gave up on it,
// and the task was recorded as "No local model was available to run this".
// Here a stand-in Ollama does what it did - or finishes, or never answers -
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
const { defaultContextTokens } = await import("../src/services/localModel.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** The turn from 2 October, with the model it named. */
const checklist = { mode: "general", model: "qwen2.5:3b", message: "Write a short checklist, eight items, for reviewing a pull request." };
/** Where the model got to before it was cut off, or the whole of it when it finishes. */
const written = "1. Read the description.\n2. Run the tests.\n3. Read the diff.\n4. Run the tests.\n";

type Ending = "stop" | "length" | "never";
type ChatRequest = { model?: string; stream?: boolean; options?: { num_ctx?: number; num_predict?: number } };

/**
 * A stand-in Ollama with the two models this PC had. Every chat request is
 * recorded and answered with `written`, ending as `ending` says: "stop" is a
 * model that finished, "length" one the reply limit cut off, "never" one that
 * is still going when the request gives up. Streamed when the request asks for
 * a stream, as NDJSON frames, the way the web client's route is answered.
 */
function fakeOllama(ending: Ending, installed = ["qwen2.5:3b", "llama3.2:latest"]) {
  const chats: ChatRequest[] = [];
  return new Promise<{ server: Server; baseUrl: string; chats: ChatRequest[] }>((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        if (request.url?.startsWith("/api/tags")) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ models: installed.map((name) => ({ name })) }));
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
        chats.push(body);
        if (ending === "never") return; // holds the request open, generating as far as anyone can tell
        const model = body.model ?? "qwen2.5:3b";
        const last = { model, message: { role: "assistant", content: "" }, done: true, done_reason: ending };
        if (body.stream) {
          response.writeHead(200, { "Content-Type": "application/x-ndjson" });
          for (const line of written.split(/(?<=\n)/)) {
            response.write(`${JSON.stringify({ model, message: { role: "assistant", content: line }, done: false })}\n`);
          }
          response.end(`${JSON.stringify(last)}\n`);
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ...last, message: { role: "assistant", content: written } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chats });
    });
  });
}

/**
 * One turn against `ollama`, then what the Task center reads for that
 * session: the current task and the history. `stream` sends it the way the
 * web client does.
 */
async function turn(
  ollama: { baseUrl: string },
  sessionId: string,
  options: { stream?: boolean; body?: Record<string, unknown> } = {}
) {
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = ollama.baseUrl;
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
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
    await new Promise<void>((resolve) => app.close(() => resolve()));
  }
}

test("every request carries the reply limit, and a reply that finishes is the answer", async () => {
  // The control for the tests below: the same stand-in, the same words, and
  // only the ending differs.
  const ollama = await fakeOllama("stop");
  try {
    const { reply, task, finished } = await turn(ollama, "limit-finishes");
    assert.ok(ollama.chats.length > 0, "the request reached the model");
    for (const chat of ollama.chats) {
      assert.equal(chat.options?.num_predict, defaultContextTokens, "no reply may run past one window");
      assert.equal(chat.options?.num_ctx, defaultContextTokens);
    }
    assert.match(reply, /Read the description/);
    assert.equal(task.status, "succeeded");
    assert.equal(task.error, undefined);
    assert.equal(finished.status, "succeeded");
  } finally {
    ollama.server.close();
  }
});

test("a reply cut off at the length limit is recorded as too long - not as the answer, and not as no model", async () => {
  const ollama = await fakeOllama("length");
  try {
    const { reply, task, finished } = await turn(ollama, "limit-runs-on");
    // Asked once, of the model the turn named: a reply that ran on is not
    // handed to the next installed model, which would start it over.
    assert.deepEqual(ollama.chats.map((chat) => chat.model), ["qwen2.5:3b"]);
    assert.doesNotMatch(reply, /Read the description|Run the tests/, "none of the cut-off reply is shown as the answer");

    const tooLong = "The reply from qwen2.5:3b ran past the length limit (16,384 tokens) without finishing.";
    assert.equal(task.status, "failed", "a model took it and came back without an answer");
    assert.equal(task.error, tooLong);
    assert.equal(task.running, false);
    assert.equal(finished.status, "failed");
    assert.equal(finished.error, tooLong);
  } finally {
    ollama.server.close();
  }
});

test("the same, streamed - the way the web client asks", async () => {
  const ollama = await fakeOllama("length");
  try {
    const { reply, task, finished } = await turn(ollama, "limit-runs-on-streamed", { stream: true });
    assert.deepEqual(ollama.chats.map((chat) => chat.stream), [true], "the streamed path, which reads the reason from the last frame");
    assert.doesNotMatch(reply, /Read the description|Run the tests/, "the done event does not carry the cut-off reply as the answer");
    assert.equal(task.status, "failed");
    assert.match(task.error ?? "", /^The reply from qwen2\.5:3b ran past the length limit \(16,384 tokens\)/);
    assert.equal(finished.error, task.error);
  } finally {
    ollama.server.close();
  }
});

test("a model that does not reply in time is recorded as that, with the time it was given", async () => {
  const ollama = await fakeOllama("never");
  const previousTimeout = process.env.OLLAMA_TIMEOUT_MS;
  process.env.OLLAMA_TIMEOUT_MS = "1000";
  try {
    const { task, finished } = await turn(ollama, "limit-times-out");
    // The model was asked: the time ran out on the reply, not on reaching it.
    assert.deepEqual(ollama.chats.map((chat) => chat.model), ["qwen2.5:3b"]);
    assert.equal(task.status, "failed");
    assert.equal(task.error, "qwen2.5:3b did not reply within 1 s.");
    assert.doesNotMatch(task.error ?? "", /no local model|unavailable/i);
    assert.equal(finished.error, task.error);
  } finally {
    if (previousTimeout === undefined) delete process.env.OLLAMA_TIMEOUT_MS;
    else process.env.OLLAMA_TIMEOUT_MS = previousTimeout;
    ollama.server.closeAllConnections();
    ollama.server.close();
  }
});

test("no model installed is recorded as that, and as blocked rather than failed", async () => {
  // The one case the old words were true of - and still worded from what
  // Ollama said, rather than a sentence fixed in advance.
  const ollama = await fakeOllama("stop", []);
  try {
    const { task, finished } = await turn(ollama, "limit-no-model");
    assert.equal(ollama.chats.length, 0, "there was nothing to ask");
    assert.equal(task.status, "blocked", "the work never ran");
    assert.match(task.error ?? "", /^Ollama is running at http:\/\/127\.0\.0\.1:\d+ but has no models pulled\./);
    assert.equal(finished.status, "blocked");
  } finally {
    ollama.server.close();
  }
});

test("a web search whose model ran on says so, not that there is no model", async () => {
  // orchestrator-generation.test.ts covers the search with no model at all,
  // which still says the model is not available.
  const ollama = await fakeOllama("length");
  try {
    const { reply, task } = await turn(ollama, "limit-web-search", {
      body: { message: "search the web for the official Node.js release schedule" }
    });
    assert.ok(ollama.chats.length > 0, "the request reached the model");
    assert.match(reply, /^I couldn't finish that web search\. The reply from qwen2\.5:3b ran past the length limit/);
    assert.doesNotMatch(reply, /isn't available/);
    assert.equal(task.status, "failed");
  } finally {
    ollama.server.close();
  }
});
