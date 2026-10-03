import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

// A streamed reply that is still being written: Stop, and the time limit, must
// both reach it. fetch() resolves when a reply's headers arrive, and Ollama
// sends those with the reply's first words. The time limit and the Stop relay
// were both let go of at that moment, so once a reply had begun nothing ended
// it: the model wrote on until it was done, holding the GPU, while Stop closed
// only the browser's own connection.
//
// The stand-in Ollama below sends the start of a reply and then holds the
// request open - what a model that writes on and on looks like from outside -
// and notes when the asker lets go of it, which is what makes a real Ollama
// stop generating. Every store the route touches is pointed at a temporary
// directory before server.js loads, as in reply-limit.test.ts.
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-stream-stop-"));
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

/** A turn that reaches the model, the way the web client sends it. */
const checklist = { mode: "general", model: "qwen2.5:3b", message: "Write a short checklist, eight items, for reviewing a pull request." };
/** The start of the reply. The rest never comes. */
const opening = "Here is a checklist:\n1. Read the description.\n";

type ChatRequest = { model?: string; stream?: boolean };

/**
 * A stand-in Ollama whose streamed reply begins and never ends. `abandoned`
 * resolves when a request for one is let go of before it ended. Two models are
 * installed, so handing the work to a second one would be possible - and would
 * show in `chats`.
 */
function endlessOllama() {
  const chats: ChatRequest[] = [];
  let markAbandoned!: () => void;
  const abandoned = new Promise<void>((resolve) => { markAbandoned = resolve; });
  return new Promise<{ server: Server; baseUrl: string; chats: ChatRequest[]; abandoned: Promise<void> }>((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        if (request.url?.startsWith("/api/tags")) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ models: [{ name: "qwen2.5:3b" }, { name: "llama3.2:latest" }] }));
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
        chats.push(body);
        response.on("close", () => {
          if (!response.writableEnded) markAbandoned();
        });
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        for (const line of opening.split(/(?<=\n)/)) {
          response.write(`${JSON.stringify({ model: body.model, message: { role: "assistant", content: line }, done: false })}\n`);
        }
        // ...and nothing after that.
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chats, abandoned });
    });
  });
}

/** The API, asking `ollama`, with `env` set for as long as `use` runs. */
async function withApi(ollama: { baseUrl: string }, env: Record<string, string>, use: (base: string) => Promise<void>) {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({ OLLAMA_BASE_URL: ollama.baseUrl, ...env })) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  const app = createApp().listen(0, "127.0.0.1");
  await once(app, "listening");
  try {
    await use(`http://127.0.0.1:${(app.address() as AddressInfo).port}`);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    app.closeAllConnections();
    await new Promise<void>((resolve) => app.close(() => resolve()));
  }
}

/** Starts the streamed turn, the way the web client does; `leave` is its Stop. */
async function startTurn(base: string, sessionId: string, leave: AbortController) {
  const response = await fetch(`${base}/v1/assist/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...checklist, sessionId }),
    signal: leave.signal
  });
  assert.equal(response.status, 200);
  return response.body!.getReader();
}

/** The events read until `pattern` appears in them, or until `ms` have passed. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, pattern: RegExp, ms: number): Promise<string> {
  const decoder = new TextDecoder();
  const end = Date.now() + ms;
  let text = "";
  while (!pattern.test(text) && Date.now() < end) {
    const read = reader.read();
    // A read still waiting when the turn is stopped rejects, and that is the
    // point of stopping it, not a failure.
    read.catch(() => {});
    const next = await Promise.race([read, delay(Math.max(0, end - Date.now())).then(() => null)]);
    if (!next || next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}

/** Whether the request to the model was let go of within `ms`. */
async function letGoWithin(ollama: { abandoned: Promise<void> }, ms: number): Promise<"let go" | "held"> {
  return Promise.race([ollama.abandoned.then(() => "let go" as const), delay(ms).then(() => "held" as const)]);
}

/** The session's task once it has stopped running, as the Task center reads it. */
async function settledTask(base: string, sessionId: string) {
  const end = Date.now() + 5000;
  for (;;) {
    const current = (await (await fetch(`${base}/v1/agent-tasks?sessionId=${sessionId}`)).json()) as {
      data: { tasks: Array<{ status: string; error?: string; running: boolean }> };
    };
    const task = current.data.tasks[0];
    if ((task && !task.running) || Date.now() > end) return task;
    await delay(50);
  }
}

/** The session's newest stored reply, once the turn has been written to its conversation. */
async function storedReply(base: string, sessionId: string) {
  const end = Date.now() + 5000;
  for (;;) {
    const listed = (await (await fetch(`${base}/v1/conversations?sessionId=${sessionId}`)).json()) as {
      data: { conversations: Array<{ id: string }> };
    };
    const id = listed.data.conversations[0]?.id;
    if (id) {
      const opened = (await (await fetch(`${base}/v1/conversations/${id}?sessionId=${sessionId}`)).json()) as {
        data: { conversation: { turns: Array<{ role: string; content: string; strategy?: string }> } };
      };
      const replies = opened.data.conversation.turns.filter((turn) => turn.role === "assistant");
      const reply = replies[replies.length - 1];
      if (reply) return { content: reply.content, strategy: reply.strategy };
    }
    if (Date.now() > end) return null;
    await delay(50);
  }
}

test("Stop reaches a reply that is already streaming, and the model is let go of", async () => {
  const ollama = await endlessOllama();
  await withApi(ollama, {}, async (base) => {
    const stop = new AbortController();
    try {
      const reader = await startTurn(base, "stream-stop", stop);
      const shown = await readUntil(reader, /event: token/, 5000);
      // Stopped part way through the reply, not while the model was still
      // being asked: that case never reached the gap.
      assert.match(shown, /event: token\ndata: \{"text":"Here is a checklist/, "the reply had started on screen");
      // The control. Left alone, the request stays open while the reply is
      // written, so "let go of" below is the Stop and nothing else.
      assert.equal(await letGoWithin(ollama, 500), "held", "nothing ends a reply that is still being written but Stop or the time limit");

      stop.abort(); // what the Stop button does
      assert.equal(await letGoWithin(ollama, 5000), "let go", "Stop let go of the request to the model, which is what stops it generating");
      assert.deepEqual(ollama.chats.map((chat) => chat.stream), [true], "asked once, streamed, and not handed to another model to start again");

      const task = await settledTask(base, "stream-stop");
      assert.equal(task.running, false);
      assert.equal(task.status, "blocked", "stopped by the user, not failed by the model");
      assert.equal(task.error, "Stopped before it finished.");
      // And kept in the conversation as stopped, which is what the reloaded
      // transcript shows - not the composer's fallback standing as the reply.
      assert.deepEqual(await storedReply(base, "stream-stop"), { content: "Stopped before it finished.", strategy: "stopped" });
    } finally {
      stop.abort();
      ollama.server.closeAllConnections();
      ollama.server.close();
    }
  });
});

test("the time limit reaches a reply that is already streaming, and says it began and did not finish", async () => {
  const ollama = await endlessOllama();
  await withApi(ollama, { OLLAMA_TIMEOUT_MS: "1000" }, async (base) => {
    const leave = new AbortController();
    try {
      const reader = await startTurn(base, "stream-time-limit", leave);
      const events = await readUntil(reader, /event: (done|failed)/, 10_000);
      assert.match(events, /event: token\ndata: \{"text":"Here is a checklist/, "the reply had started on screen before the time ran out");
      assert.match(events, /event: done/, "the turn ended: the time limit reached a reply already under way");
      assert.equal(await letGoWithin(ollama, 2000), "let go", "and the request to the model was let go of");
      assert.deepEqual(ollama.chats.map((chat) => chat.model), ["qwen2.5:3b"], "asked once: not handed to the other installed model to start over");

      // What replaces the words on screen: why there is no answer. Not the
      // unfinished reply, and not the composer's generic plan, which is what
      // this turn fell back to before ("1. Clarify the end state for the
      // short checklist...").
      const done = JSON.parse(/event: done\ndata: (.+)/.exec(events)![1]) as { assistantMessage: string; strategy: string };
      assert.equal(done.assistantMessage, "I couldn't finish that. qwen2.5:3b did not finish its reply within 1 s. Try again in a moment.");
      assert.equal(done.strategy, "failed");

      const task = await settledTask(base, "stream-time-limit");
      assert.equal(task.status, "failed", "a model took it and came back without an answer");
      // Not "did not reply": its first words had been on screen the whole time.
      assert.equal(task.error, "qwen2.5:3b did not finish its reply within 1 s.");
    } finally {
      leave.abort();
      ollama.server.closeAllConnections();
      ollama.server.close();
    }
  });
});
