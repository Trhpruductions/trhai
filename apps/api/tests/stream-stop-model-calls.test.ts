import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

// Stop has to reach every model a turn is waiting on, not only the agent
// loop's own streamed reply (stream-stop.test.ts). A turn also asks the vision
// model about an image, and the local model to write a summary, an app, a
// video script or a mockup, and none of those calls took the Stop signal.
// Stop closed the browser's connection while the model went on looking or
// writing, holding the GPU, until its own time limit: two to five minutes.
//
// The stand-in Ollama below answers the chat model with a tool call, and holds
// any request to look or to write open without answering - what a model still
// at work looks like from outside - noting when the asker lets go of it, which
// is what makes a real Ollama stop. Every store the route touches, and the
// workspace the tools read, are temporary directories set before server.js
// loads, as in stream-stop.test.ts.
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-stop-calls-"));
const workspace = mkdtempSync(path.join(tmpdir(), "ascend-stop-calls-ws-"));
process.env.ASCEND_WORKSPACE = workspace;
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASSIST_TASK_FILE = path.join(dataDir, "tasks.json");
process.env.ASSIST_TASK_HISTORY_FILE = path.join(dataDir, "task-history.json");
process.env.ASSIST_TOOL_USAGE_FILE = path.join(dataDir, "tool-usage.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

const chatModel = "qwen2.5:3b";
const visionModel = "qwen2.5vl:3b";
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ffa5d6a40000000049454e44ae426082", "hex");

type ToolCall = { name: string; arguments: Record<string, unknown> };
/** One request to a model: where it went, and which model it asked. */
type Asked = { url: string; model: string };

/**
 * A stand-in Ollama for one turn.
 *
 * The chat model answers its first request with `toolCall`, streamed the way
 * Ollama streams one, and anything after that with a line of text. A request
 * to look (the vision model) or to write (/api/generate) is held open and
 * never answered. `held` resolves with the first such request when it
 * arrives; `abandoned` when it is let go of before it ended.
 */
function standInOllama(toolCall?: ToolCall) {
  const asked: Asked[] = [];
  let markHeld!: (request: Asked) => void;
  let markAbandoned!: () => void;
  const held = new Promise<Asked>((resolve) => { markHeld = resolve; });
  const abandoned = new Promise<void>((resolve) => { markAbandoned = resolve; });
  let chats = 0;
  return new Promise<{ server: Server; baseUrl: string; asked: Asked[]; held: Promise<Asked>; abandoned: Promise<void> }>((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        if (request.url?.startsWith("/api/tags")) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ models: [{ name: chatModel }, { name: visionModel }] }));
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
        const entry = { url: request.url ?? "", model: body.model };
        asked.push(entry);
        if (entry.url === "/api/chat" && entry.model !== visionModel) {
          chats += 1;
          const message = chats === 1 && toolCall
            ? { role: "assistant", content: "", tool_calls: [{ function: toolCall }] }
            : { role: "assistant", content: "Done." };
          response.writeHead(200, { "Content-Type": "application/x-ndjson" });
          response.write(`${JSON.stringify({ model: entry.model, message, done: false })}\n`);
          response.end(`${JSON.stringify({ model: entry.model, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`);
          return;
        }
        // Looking at the image, or writing: no answer, and nothing to say one
        // is coming - what Ollama sends for an unstreamed request until it is
        // done.
        response.on("close", () => {
          if (!response.writableEnded) markAbandoned();
        });
        markHeld(entry);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked, held, abandoned });
    });
  });
}

/** The API, asking `ollama`, for as long as `use` runs. */
async function withApi(ollama: { baseUrl: string }, use: (base: string) => Promise<void>) {
  const env: Record<string, string> = {
    OLLAMA_BASE_URL: ollama.baseUrl,
    // Named, so which model each request goes to does not depend on the PC.
    OLLAMA_MODEL: chatModel,
    OLLAMA_VISION_MODEL: visionModel
  };
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(env)) {
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

/**
 * Starts a streamed turn, the way the web client does; `stop` is its Stop
 * button. Its events are read as they arrive, as the client reads them.
 *
 * Not left unread. fetch cancels the body of a response nothing refers to
 * once it is garbage collected, closing the connection - which the route
 * takes, rightly, for the user leaving, and stops the turn. A first version
 * of this file dropped the response, and a turn that allocated enough to
 * collect garbage was stopped before Stop was pressed: the control below
 * caught it.
 */
async function startTurn(base: string, body: Record<string, unknown>, stop: AbortController) {
  const response = await fetch(`${base}/v1/assist/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "general", model: chatModel, ...body }),
    signal: stop.signal
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let events = "";
  const read = (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        events += decoder.decode(next.value, { stream: true });
      }
    } catch {
      // Stopped: the read under way rejects, which is the point of stopping.
    }
    return events;
  })();
  return { response, read };
}

/** The request the turn is waiting on, once it reaches the stand-in - or null if none did within `ms`. */
async function heldWithin(ollama: { held: Promise<Asked> }, ms: number): Promise<Asked | null> {
  return Promise.race([ollama.held, delay(ms).then(() => null)]);
}

/** Whether that request was let go of within `ms`. */
async function letGoWithin(ollama: { abandoned: Promise<void> }, ms: number): Promise<"let go" | "held"> {
  return Promise.race([ollama.abandoned.then(() => "let go" as const), delay(ms).then(() => "held" as const)]);
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

/** The steps of the turn whose label starts with `label`, as the activity panel shows them. */
async function stepsLabelled(base: string, sessionId: string, label: string) {
  const listed = (await (await fetch(`${base}/v1/execution?sessionId=${sessionId}`)).json()) as {
    data: { events: Array<{ label: string; status: string; detail?: string }> };
  };
  return listed.data.events
    .filter((event) => event.label.startsWith(label))
    .map((event) => ({ label: event.label, status: event.status, detail: event.detail }));
}

/** A text far longer than the model reads at once, so a summary of it goes section by section. */
const longReport = Array.from({ length: 400 }, (_, index) =>
  `Section ${index + 1}. The harbor opens at six, the ferry leaves at seven, and the market closes at noon on Saturdays.`
).join("\n\n");

type Case = {
  /** What the turn was doing when Stop was pressed. */
  doing: string;
  sessionId: string;
  /** The turn, as the web client sends it. */
  turn: Record<string, unknown>;
  /** What the chat model asks for first, when the turn goes through the agent loop. */
  toolCall?: ToolCall;
  /** Anything the turn needs to exist first. */
  prepare?: (base: string, sessionId: string) => Promise<void>;
  /** The request the turn is waiting on when Stop is pressed. */
  waitingOn: Asked;
  /** Whether the turn runs as a task, which the Task center then shows as stopped. */
  task: boolean;
  /** For a tool that retries its writing: the activity step each attempt opens. */
  attemptStep?: string;
};

const cases: Case[] = [
  {
    doing: "the vision model looking at an image sent with the message",
    sessionId: "stop-image",
    turn: { message: "What does this say?", images: [{ name: "receipt.png", data: png.toString("base64") }] },
    waitingOn: { url: "/api/chat", model: visionModel },
    task: false
  },
  {
    doing: "the vision model looking at an image file for look_at_image",
    sessionId: "stop-look-at-image",
    turn: { message: "what's in cat.png?" },
    toolCall: { name: "look_at_image", arguments: { path: "cat.png", question: "What is in it?" } },
    prepare: async () => { writeFileSync(path.join(workspace, "cat.png"), png); },
    waitingOn: { url: "/api/chat", model: visionModel },
    task: true
  },
  {
    doing: "the model summarizing a saved document",
    sessionId: "stop-saved-summary",
    turn: { message: "summarize the Harbor Town Handbook" },
    prepare: async (base, sessionId) => {
      const saved = await fetch(`${base}/v1/knowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, title: "Harbor Town Handbook", body: "The harbor opens at six. The ferry leaves at seven." })
      });
      assert.equal(saved.status, 201, "the document was saved");
    },
    waitingOn: { url: "/api/generate", model: chatModel },
    task: false
  },
  {
    doing: "the model taking notes on a long file for summarize_document",
    sessionId: "stop-summarize-document",
    turn: { message: "summarize the file report.txt" },
    toolCall: { name: "summarize_document", arguments: { path: "report.txt" } },
    prepare: async () => { writeFileSync(path.join(workspace, "report.txt"), longReport); },
    waitingOn: { url: "/api/generate", model: chatModel },
    task: true
  },
  {
    doing: "the model writing an app for build_app",
    sessionId: "stop-build-app",
    turn: { message: "build me a snake game" },
    toolCall: { name: "build_app", arguments: { description: "a snake game you steer with the arrow keys" } },
    waitingOn: { url: "/api/generate", model: chatModel },
    task: true,
    attemptStep: "Writing the app"
  },
  {
    doing: "the model writing a video script for make_video",
    sessionId: "stop-make-video",
    turn: { message: "make a short video about our product launch" },
    toolCall: { name: "make_video", arguments: { description: "a short video about our product launch" } },
    waitingOn: { url: "/api/generate", model: chatModel },
    task: true,
    attemptStep: "Writing the video script"
  },
  {
    doing: "the model drawing a mockup for render_mockup",
    sessionId: "stop-render-mockup",
    turn: { message: "render a mockup of a login page" },
    toolCall: { name: "render_mockup", arguments: { description: "a login page", kind: "mockup" } },
    waitingOn: { url: "/api/generate", model: chatModel },
    task: true
  }
];

for (const each of cases) {
  test(`Stop reaches ${each.doing}, and the model is let go of`, async (t) => {
    const ollama = await standInOllama(each.toolCall);
    await withApi(ollama, async (base) => {
      const stop = new AbortController();
      try {
        await each.prepare?.(base, each.sessionId);
        const turn = await startTurn(base, { ...each.turn, sessionId: each.sessionId }, stop);

        // The turn reached the call this is about, and is waiting on it.
        assert.deepEqual(await heldWithin(ollama, 10_000), each.waitingOn, "the turn is waiting on the model");
        // The control. Left alone, the request stays open while the model
        // works, so "let go of" below is the Stop and nothing else - every
        // time limit on these calls is two minutes or more.
        assert.equal(await letGoWithin(ollama, 500), "held", "nothing ends a request the model is still answering but Stop or its time limit");
        const askedBeforeStop = ollama.asked.length;

        const stoppedAt = Date.now();
        stop.abort(); // what the Stop button does
        assert.equal(await letGoWithin(ollama, 5000), "let go", "Stop let go of the request, which is what stops the model");
        t.diagnostic(`let go ${Date.now() - stoppedAt} ms after Stop`);
        // The client's own read ended with the Stop, before any answer came.
        assert.doesNotMatch(await turn.read, /event: done/, "no answer had arrived when Stop was pressed");
        assert.equal(turn.response.status, 200);

        // Said as stopped, in the conversation the reloaded transcript shows -
        // not as the model failing, and not as "did not reply within".
        assert.deepEqual(await storedReply(base, each.sessionId), { content: "Stopped before it finished.", strategy: "stopped" });
        // Nothing asked of a model after Stop: not the chat model to go on,
        // not another attempt at the writing.
        assert.equal(ollama.asked.length, askedBeforeStop, "nothing was asked of a model after Stop");
        assert.deepEqual(ollama.asked.at(-1), each.waitingOn);

        if (each.task) {
          const task = await settledTask(base, each.sessionId);
          assert.equal(task?.status, "blocked", "stopped by the user, not failed by the model");
          assert.equal(task?.error, "Stopped before it finished.");
        }
        if (each.attemptStep) {
          // One attempt, ended by Stop. The tool tries its writing three times
          // when an attempt fails, and a stopped one is not tried again.
          assert.deepEqual(await stepsLabelled(base, each.sessionId, each.attemptStep),
            [{ label: each.attemptStep, status: "failed", detail: "Stopped before it finished." }]);
        }
      } finally {
        stop.abort();
        ollama.server.closeAllConnections();
        ollama.server.close();
      }
    });
  });
}
