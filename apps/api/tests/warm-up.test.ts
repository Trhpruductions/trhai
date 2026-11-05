import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The warm-up has the engine read the front every turn's prompt shares, so the
// first question reads only the rest. It is worth something only if that
// front is the real one, character for character - the engine reuses a prompt
// only up to its first difference - so the real turns here are run through the
// agent loop and compared with what the warm-up sends.

process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "ascend-warm-up-"));
const { runAgent } = await import("../src/services/agentLoop.js");
const { alwaysOfferedTools, availableTools, toolDefinitions } = await import("../src/services/agentTools.js");
const { loadsAtStart, warmUpEngine, warmUpRequest, warmUpStatus, resetWarmUpForTests } = await import("../src/services/warmUp.js");
const { loadEngineModel } = await import("../src/services/modelEngine.js");
const { fakeEngine } = await import("./helpers/fakeEngine.js");
type LocalModelConfig = import("../src/services/localModel.js").LocalModelConfig;

const front = [...alwaysOfferedTools] as string[];
const now = new Date("2026-10-18T09:30:00Z");
const configFor = (baseUrl: string, model = "llama3.2"): LocalModelConfig =>
  ({ baseUrl, model, modelFromEnv: true, timeoutMs: 4000 });
const names = (tools: Array<{ function: { name: string } }> | undefined) => (tools ?? []).map((tool) => tool.function.name);
// The PC, said outright: what a warm-up at start does depends on it, and a test must not depend on the PC it runs on.
const noCard = { gpu: null };
const withCard = { gpu: { vendor: "nvidia" as const, name: "A card", memoryMiB: 8192, driver: "581.0" } };

test("the tools every turn is offered come first, in one order, whatever else is offered", () => {
  for (const name of front) {
    assert.ok(toolDefinitions.some((definition) => definition.function.name === name), `${name} is a tool`);
  }
  const everyOptionOff = {
    scaffolding: false, changes: false, arithmetic: false, dates: false, clock: false, web: false, time: false,
    writes: false, memory: false, render: false, files: false, schedules: false, video: false, documents: false,
    status: false, launch: false, messaging: false, summaries: false, images: false
  };
  for (const [label, armed, options] of [
    ["everything on offer", true, {}],
    ["disarmed", false, {}],
    ["a plain question", false, { writes: false, scaffolding: false, files: false }],
    ["every condition off", false, everyOptionOff],
    ["a coding request, armed", true, { scaffolding: false, web: false, render: false }]
  ] as const) {
    const offered = names(availableTools(armed, options));
    assert.deepEqual(offered.slice(0, front.length), front, label);
  }
  // A summary withholds the two readers; the rest of the front keeps its order.
  const summary = names(availableTools(false, { summaries: true, readers: false }));
  assert.deepEqual(summary.slice(0, front.length - 2), front.filter((name) => name !== "read_document" && name !== "read_file"));
});

test("a real turn starts with exactly what the warm-up has the engine read", async () => {
  const engine = await fakeEngine({ reply: { message: { content: "Done." } } });
  try {
    const { body } = warmUpRequest("llama3.2", now);
    const warmMessages = body.messages as Array<{ role: string; content: string }>;
    const warmTools = names(body.tools as Array<{ function: { name: string } }>);
    assert.equal(warmMessages[0].role, "system");
    assert.deepEqual(warmTools, front);

    for (const question of [
      "Write a one-line Python function that reverses a string.",
      "What is the capital of Australia?",
      "Explain what a mutex is."
    ]) {
      const before = engine.chats.length;
      await runAgent(configFor(engine.baseUrl), question, { memories: [], knowledge: [], now: () => now });
      const sent = engine.chats[before];
      assert.ok(sent, `${question}: a request was sent`);
      assert.equal(sent.messages?.[0]?.content, warmMessages[0].content, `${question}: the same system message`);
      assert.deepEqual(names(sent.tools).slice(0, front.length), warmTools, `${question}: the same tools first`);
    }
  } finally {
    await engine.close();
  }
});

test("the warm-up reads the front once, and does nothing while the model still holds it", async () => {
  resetWarmUpForTests();
  const engine = await fakeEngine({
    models: ["llama3.2:latest"],
    reply: () => ({ message: { content: "Y" } })
  });
  try {
    const first = await warmUpEngine({ reason: "start", config: configFor(engine.baseUrl), now: () => now, hardware: noCard });
    assert.equal(first.state, "warm");
    assert.equal(engine.chats.length, 1);
    assert.equal(engine.chats[0].max_tokens, 1, "it asks for one token: reading the prompt is the point");
    assert.deepEqual(names(engine.chats[0].tools), front);
    assert.deepEqual(warmUpStatus(), first);

    const again = await warmUpEngine({ reason: "composer", config: configFor(engine.baseUrl), now: () => now });
    assert.equal(again.state, "warm");
    assert.equal(engine.chats.length, 1, "nothing was sent the second time");
  } finally {
    await engine.close();
    resetWarmUpForTests();
  }
});

test("one warm-up at a time: a second call while one runs gets the same one", async () => {
  resetWarmUpForTests();
  const engine = await fakeEngine({ reply: () => ({ message: { content: "Y" } }) });
  try {
    const [a, b] = await Promise.all([
      warmUpEngine({ reason: "start", config: configFor(engine.baseUrl), now: () => now, hardware: noCard }),
      warmUpEngine({ reason: "composer", config: configFor(engine.baseUrl), now: () => now })
    ]);
    assert.deepEqual(a, b);
    assert.equal(engine.chats.length, 1);
  } finally {
    await engine.close();
    resetWarmUpForTests();
  }
});

test("a real request stops the warm-up, and is not kept waiting on it", async () => {
  resetWarmUpForTests();
  const engine = await fakeEngine({ reply: (_body, index) => (index === 0 ? "hang" : { message: { content: "Answered." } }) });
  try {
    const warming = warmUpEngine({ reason: "start", config: configFor(engine.baseUrl), now: () => now, hardware: noCard });
    // Until the warm-up's request is with the engine.
    for (let tries = 0; engine.chats.length === 0 && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(engine.chats.length, 1);
    assert.equal(warmUpStatus().state, "warming");

    const loaded = await loadEngineModel(engine.baseUrl, "llama3.2");
    assert.equal(loaded.ok, true);
    const result = await warming;
    assert.equal(result.state, "stopped");
  } finally {
    await engine.close();
    resetWarmUpForTests();
  }
});

test("the model a conversation is using is never pushed out for a warm-up", async () => {
  resetWarmUpForTests();
  // The fake engine reports every model loaded: here the chat model and the vision model both.
  const engine = await fakeEngine({ models: ["llama3.2:latest", "qwen2.5-vl-3b"], vision: ["qwen2.5-vl-3b"] });
  try {
    const result = await warmUpEngine({ reason: "composer", config: configFor(engine.baseUrl), now: () => now });
    assert.equal(result.state, "skipped");
    assert.equal(engine.chats.length, 0);
  } finally {
    await engine.close();
    resetWarmUpForTests();
  }
});

test("TRHAI_WARM_UP=off switches it off", async () => {
  resetWarmUpForTests();
  const engine = await fakeEngine();
  process.env.TRHAI_WARM_UP = "off";
  try {
    const result = await warmUpEngine({ reason: "start", config: configFor(engine.baseUrl), now: () => now, hardware: noCard });
    assert.equal(result.state, "skipped");
    assert.equal(engine.chats.length, 0);
    assert.deepEqual(engine.urls, [], "the engine was not even asked");
  } finally {
    delete process.env.TRHAI_WARM_UP;
    await engine.close();
    resetWarmUpForTests();
  }
});

// ---------------------------------------------------------------- only when it is needed

test("starting is not needing: on a PC with a graphics card nothing is loaded at start, and the ask box still loads it", async () => {
  resetWarmUpForTests();
  const engine = await fakeEngine({ models: ["llama3.2:latest"], reply: () => ({ message: { content: "Y" } }) });
  try {
    const atStart = await warmUpEngine({ reason: "start", config: configFor(engine.baseUrl), now: () => now, hardware: withCard });
    assert.equal(atStart.state, "skipped");
    assert.match(atStart.state === "skipped" ? atStart.reason : "", /no model is loaded/);
    assert.deepEqual(engine.urls, [], "the engine was not asked for anything: no list, no load, no reading");
    assert.equal(engine.chats.length, 0);

    // Someone clicks into the ask box: now it is needed, card or no card.
    const whenAsked = await warmUpEngine({ reason: "composer", config: configFor(engine.baseUrl), now: () => now, hardware: withCard });
    assert.equal(whenAsked.state, "warm");
    assert.equal(engine.chats.length, 1);
  } finally {
    await engine.close();
    resetWarmUpForTests();
  }
});

test("a PC without a graphics card still reads the prompt at start, where the wait would be minutes", async () => {
  resetWarmUpForTests();
  const engine = await fakeEngine({ models: ["llama3.2:latest"], reply: () => ({ message: { content: "Y" } }) });
  try {
    const atStart = await warmUpEngine({ reason: "start", config: configFor(engine.baseUrl), now: () => now, hardware: noCard });
    assert.equal(atStart.state, "warm");
    assert.equal(engine.chats.length, 1);
  } finally {
    await engine.close();
    resetWarmUpForTests();
  }
});

test("which PCs load at start, and the setting that says otherwise", () => {
  assert.equal(loadsAtStart(noCard, {}), true);
  assert.equal(loadsAtStart(withCard, {}), false);
  // The owner of a PC may want the other way round, either way.
  assert.equal(loadsAtStart(withCard, { TRHAI_WARM_UP_AT_START: "on" }), true);
  assert.equal(loadsAtStart(noCard, { TRHAI_WARM_UP_AT_START: " OFF " }), false);
  // Anything else is not an answer, and the PC decides.
  assert.equal(loadsAtStart(withCard, { TRHAI_WARM_UP_AT_START: "maybe" }), false);
  assert.equal(loadsAtStart(noCard, { TRHAI_WARM_UP_AT_START: "" }), true);
});

test("the setting reaches the warm-up itself: on brings the load at start back on a PC with a card", async () => {
  resetWarmUpForTests();
  const engine = await fakeEngine({ models: ["llama3.2:latest"], reply: () => ({ message: { content: "Y" } }) });
  process.env.TRHAI_WARM_UP_AT_START = "on";
  try {
    const atStart = await warmUpEngine({ reason: "start", config: configFor(engine.baseUrl), now: () => now, hardware: withCard });
    assert.equal(atStart.state, "warm");
    assert.equal(engine.chats.length, 1);
  } finally {
    delete process.env.TRHAI_WARM_UP_AT_START;
    await engine.close();
    resetWarmUpForTests();
  }
});
