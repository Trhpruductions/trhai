import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { modelsBody, streamEvent } from "./helpers/fakeEngine.js";

// A thinking model thinks before it answers, and until now nothing said so.
// Qwen3, asked a one-line sum, thought for about eleven seconds before its
// first word, and for all of that time the chat read "Understanding" - the
// stage the turn starts in, which is also what a stalled model looks like.
//
// The engine sends a model's thoughts as they are written, beside the reply
// rather than in it. The turn's stage now follows them: "Thinking it through"
// from the first of them, and "Answering" once the reply itself begins.
//
// The stand-in engine below sends what the test tells it to and then waits to
// be told to go on, so each moment can be looked at through the same route
// the chat polls (/v1/assist/activity). Every store the route touches is a
// temporary directory set before server.js loads.
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-thinking-"));
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

const model = "qwen3-8b";
/** A turn that reaches the model, the way the web client sends it. */
const checklist = { mode: "general", model, message: "Write a short checklist, eight items, for reviewing a pull request." };

/** One step of a scripted reply: something sent, or a pause until the test says to go on. */
type Step = { thought: string } | { words: string } | "wait" | "finish";

/**
 * A stand-in engine that plays `steps` for each chat request. At each "wait"
 * it stops, resolves the next of `reached`, and goes on when `go()` is called.
 * A script with no "finish" leaves the reply open, as a model still at work does.
 */
function scriptedEngine(steps: Step[]) {
  const waits = steps.filter((step) => step === "wait").length;
  const gates = Array.from({ length: waits }, () => {
    let open!: () => void;
    let arrive!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    const reached = new Promise<void>((resolve) => { arrive = resolve; });
    return { open, arrive, opened, reached };
  });
  let chats = 0;
  const play = async (response: ServerResponse, name: string) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(streamEvent(name, { role: "assistant", content: null }));
    let gate = 0;
    for (const step of steps) {
      if (step === "wait") {
        gates[gate].arrive();
        await gates[gate].opened;
        gate += 1;
      } else if (step === "finish") {
        response.write(streamEvent(name, {}, "stop"));
        response.end("data: [DONE]\n\n");
        return;
      } else if ("thought" in step) {
        response.write(streamEvent(name, { reasoning_content: step.thought }));
      } else {
        response.write(streamEvent(name, { content: step.words }));
      }
    }
  };
  return new Promise<{ server: Server; baseUrl: string; reached: Array<Promise<void>>; go: (index: number) => void; chats: () => number }>((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        if (request.url === "/models") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(modelsBody([model])));
          return;
        }
        chats += 1;
        void play(response, model);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        reached: gates.map((gate) => gate.reached),
        go: (index) => gates[index].open(),
        chats: () => chats
      });
    });
  });
}

/** The API, asking `engine`, with `env` set for as long as `use` runs. */
async function withApi(engine: { baseUrl: string }, env: Record<string, string>, use: (base: string) => Promise<void>) {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries({ TRHAI_ENGINE_URL: engine.baseUrl, ...env })) {
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
 * Starts the streamed turn the way the web client does, and reads its events
 * as they arrive - held and read, never dropped, so the connection stays open
 * for as long as the turn runs. `events()` is everything read so far.
 */
async function startTurn(base: string, sessionId: string) {
  const response = await fetch(`${base}/v1/assist/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...checklist, sessionId })
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const finished = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    return text;
  })();
  return { events: () => text, finished };
}

type Activity = { stage: string | null; stageLabel: string | null; completedStages: Array<{ stage: string; durationMs: number }> };

/** What the chat's own poll is told about the turn right now. */
async function activity(base: string, sessionId: string): Promise<Activity> {
  return ((await (await fetch(`${base}/v1/assist/activity?sessionId=${sessionId}`)).json()) as { data: Activity }).data;
}

/** The activity once its stage is `stage`, or as it stands when `ms` have passed. */
async function activityAt(base: string, sessionId: string, stage: string, ms = 3000): Promise<Activity> {
  const end = Date.now() + ms;
  for (;;) {
    const now = await activity(base, sessionId);
    if (now.stage === stage || Date.now() > end) return now;
    await delay(25);
  }
}

test("while a model's thoughts arrive the turn says it is thinking, and then that it is answering", async () => {
  const engine = await scriptedEngine([
    { thought: "The user wants a checklist." }, { thought: " Eight items, about pull requests." }, "wait",
    { words: "1. Read the description.\n" }, "wait",
    { words: "2. Run the tests.\n" }, "finish"
  ]);
  await withApi(engine, {}, async (base) => {
    try {
      const turn = await startTurn(base, "thinking-then-answer");

      // Its thoughts have been sent, and nothing else.
      await engine.reached[0];
      const thinking = await activityAt(base, "thinking-then-answer", "reasoning");
      assert.equal(thinking.stage, "reasoning");
      assert.equal(thinking.stageLabel, "Thinking it through", "what the chat shows while it waits");
      assert.doesNotMatch(turn.events(), /event: token/, "none of the thoughts were shown as the reply");
      assert.doesNotMatch(turn.events(), /wants a checklist/);

      // The reply begins: the thinking is over, and how long it took is kept.
      engine.go(0);
      await engine.reached[1];
      const answering = await activityAt(base, "thinking-then-answer", "answering");
      assert.equal(answering.stageLabel, "Answering");
      const thought = answering.completedStages.find((entry) => entry.stage === "reasoning");
      assert.ok(thought, `the time spent thinking is recorded: ${JSON.stringify(answering.completedStages)}`);

      engine.go(1);
      const events = await turn.finished;
      const done = JSON.parse(/event: done\ndata: (.+)/.exec(events)![1]) as { assistantMessage: string; strategy: string };
      assert.equal(done.strategy, "generated");
      assert.match(done.assistantMessage, /1\. Read the description\.\n2\. Run the tests\./);
      assert.doesNotMatch(done.assistantMessage, /wants a checklist|Eight items, about/, "the reply is the answer alone");
      assert.equal((await activity(base, "thinking-then-answer")).stage, null, "and the turn is over");
    } finally {
      engine.server.closeAllConnections();
      engine.server.close();
    }
  });
});

test("a model that sends no thoughts is never said to be thinking", async () => {
  // The control for the test above: the same route and the same wait, with a
  // reply that simply begins. "Thinking it through" has to come from thoughts
  // arriving, not from a reply taking its time.
  const engine = await scriptedEngine([{ words: "1. Read the description.\n" }, "wait", { words: "2. Run the tests.\n" }, "finish"]);
  await withApi(engine, {}, async (base) => {
    try {
      const turn = await startTurn(base, "no-thoughts");
      await engine.reached[0];
      const seen = new Set<string | null>();
      const until = Date.now() + 600;
      while (Date.now() < until) {
        seen.add((await activity(base, "no-thoughts")).stage);
        await delay(25);
      }
      assert.ok(!seen.has("reasoning"), `stages seen while the reply was held: ${[...seen].join(", ")}`);
      assert.ok(seen.has("understanding"), "it stays in the stage the turn began in");
      engine.go(0);
      assert.match(await turn.finished, /event: done/);
    } finally {
      engine.server.closeAllConnections();
      engine.server.close();
    }
  });
});

test("time that runs out while the model is still thinking is said as that", async () => {
  // Thoughts, and then nothing: no word of a reply before the time limit.
  const engine = await scriptedEngine([{ thought: "The user wants a checklist." }, { thought: " Let me consider what matters most." }, "wait"]);
  await withApi(engine, { TRHAI_MODEL_TIMEOUT_MS: "1000" }, async (base) => {
    try {
      const turn = await startTurn(base, "thinking-too-long");
      const events = await turn.finished;
      const done = JSON.parse(/event: done\ndata: (.+)/.exec(events)![1]) as { assistantMessage: string; strategy: string };
      // Not "did not finish its reply": none of it had been on screen. And
      // not "did not reply": the model was at work the whole time.
      assert.equal(done.assistantMessage,
        "I couldn't finish that. qwen3-8b was still thinking after 1 s, and had not begun its reply. Try again in a moment.");
      assert.equal(done.strategy, "failed");
      assert.doesNotMatch(events, /event: token/);
      assert.equal(engine.chats(), 1, "asked once: not handed to another model to think it over again");

      const tasks = ((await (await fetch(`${base}/v1/agent-tasks?sessionId=thinking-too-long`)).json()) as {
        data: { tasks: Array<{ status: string; error?: string }> };
      }).data.tasks;
      assert.equal(tasks[0]?.status, "failed");
      assert.equal(tasks[0]?.error, "qwen3-8b was still thinking after 1 s, and had not begun its reply.");
    } finally {
      engine.server.closeAllConnections();
      engine.server.close();
    }
  });
});
