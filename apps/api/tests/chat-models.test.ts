import test from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LocalModelConfig } from "../src/services/localModel.js";
import type { EngineModel } from "../src/services/modelEngine.js";
import { fakeEngine, modelsBody } from "./helpers/fakeEngine.js";

// A model per conversation, and how full the model's context window was -
// the two things the chat header shows next to the conversation's name.

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-chat-models-"));
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");
process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "ascend-chat-models-ws-"));

const { chatModelsFrom, isModelName, listChatModels, sizeFromName, withChosenModel } = await import("../src/services/modelCatalog.js");
const { recordContextUse, takeContextUse } = await import("../src/services/contextUse.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { getConversation, resetConversations } = await import("../src/services/conversationStore.js");
const { createApp } = await import("../src/server.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const id = () => globalThis.crypto.randomUUID();

// ---- which models can hold a conversation ---------------------------------

/** A model as the engine lists it. Not loaded, so it says no size or window, unless told. */
const listed = (id: string, more: Partial<EngineModel> = {}): EngineModel =>
  ({ id, status: "unloaded", windowTokens: null, sizeBytes: null, vision: false, failed: false, ...more });

test("the list leaves out the vision model and embedding models, and is sorted", () => {
  const models = chatModelsFrom([
    listed("qwen2.5-coder-7b"),
    listed("qwen2.5-vl-3b", { vision: true }),
    listed("nomic-embed-text"),
    listed("llama3.1-8b", { status: "loaded", sizeBytes: 4_900_000_000, windowTokens: 16384 })
  ], new Map([["qwen2.5-coder-7b", 4_683_087_332]]));
  assert.deepEqual(models.map((model) => model.name), ["llama3.1-8b", "qwen2.5-coder-7b"]);
  // The size comes from the file on disk where the engine has not loaded the model and so does not say.
  assert.deepEqual(models[1], { name: "qwen2.5-coder-7b", parameterSize: "7B", family: null, sizeBytes: 4_683_087_332 });
  assert.equal(models[0].sizeBytes, 4_900_000_000, "and from the engine where it has");
});

test("a model's size is read from its name, in either spelling", () => {
  assert.equal(sizeFromName("qwen2.5-coder-7b"), "7B");
  assert.equal(sizeFromName("qwen2.5-coder:7b"), "7B");
  assert.equal(sizeFromName("qwen3-8b"), "8B");
  assert.equal(sizeFromName("phi-3.5b-mini"), "3.5B");
  assert.equal(sizeFromName("vexora"), null);
  assert.equal(sizeFromName("qwen2.5"), null, "a version number is not a size");
});

test("model names are checked, not trusted", () => {
  for (const good of ["qwen2.5-coder:7b", "llama3.1:8b", "hf.co/org/model:Q4_K_M", "vexora:latest"]) assert.equal(isModelName(good), true, good);
  for (const bad of ["", "a b", "model;rm -rf", "x".repeat(101), 3, null]) assert.equal(isModelName(bad), false, String(bad));
});

test("a chosen model is asked for by name; no choice leaves the config alone", () => {
  const base = { baseUrl: "http://127.0.0.1:1", model: "qwen2.5-coder:7b", modelFromEnv: false, timeoutMs: 1000 };
  assert.deepEqual(withChosenModel(base, "llama3.1:8b"), { ...base, model: "llama3.1:8b", modelFromEnv: true });
  assert.equal(withChosenModel(base, undefined), base);
  assert.equal(withChosenModel(base, "not a name!"), base);
});

test("the catalogue names the model that answers when a conversation picks none", async () => {
  const models = modelsBody(["qwen2.5-coder-7b", "llama3.1-8b", "qwen2.5-vl-3b"], { vision: ["qwen2.5-vl-3b"] });
  const fetchModels = (async () => new Response(JSON.stringify(models), { status: 200 })) as typeof fetch;
  // Named the way a .env written under Ollama names it: still the same model.
  const catalogue = await listChatModels({ baseUrl: "http://engine", model: "qwen2.5-coder:7b", modelFromEnv: true, timeoutMs: 1000 }, fetchModels);
  assert.equal(catalogue.defaultModel, "qwen2.5-coder-7b");
  assert.deepEqual(catalogue.models.map((model) => model.name), ["llama3.1-8b", "qwen2.5-coder-7b"]);

  const down = (async () => { throw new Error("connection refused"); }) as typeof fetch;
  const nothing = await listChatModels({ baseUrl: "http://engine", model: "x", modelFromEnv: true, timeoutMs: 1000 }, down);
  assert.deepEqual(nothing.models, []);
  assert.match(nothing.reason ?? "", /No local model server/);
});

// ---- how full the context window was ---------------------------------------

test("a measurement is reported once, then gone", () => {
  recordContextUse("s", { promptTokens: 7000, windowTokens: 16384 });
  assert.deepEqual(takeContextUse("s"), { promptTokens: 7000, windowTokens: 16384 });
  assert.equal(takeContextUse("s"), null, "never shown again for a later reply");
});

test("the agent loop records the prompt it actually sent, against the window the engine gave the model", async () => {
  // 9,216 tokens is what an 8B model gets on an 8 GB card - not the loop's
  // own default, which is what this used to compare against.
  const engine = await fakeEngine({ models: ["llama3.1-8b"], window: 9216, reply: { message: { content: "Paris." } } });
  try {
    const config: LocalModelConfig = { baseUrl: engine.baseUrl, model: "llama3.1-8b", modelFromEnv: true, timeoutMs: 4000 };
    const result = await runAgent(config, "What is the capital of France?", { memories: [], knowledge: [], sessionId: "ctx-session" });
    assert.equal(result.ok, true);
    const use = takeContextUse("ctx-session");
    assert.ok(use, "nothing was recorded");
    assert.ok(use.promptTokens > 500, `a prompt with the rules in it is not ${use.promptTokens} tokens`);
    assert.equal(use.windowTokens, 9216);
    assert.equal(engine.chats[0].max_tokens, 9216, "and a reply may be as long as that window");
  } finally {
    await engine.close();
  }
});

// ---- the API ---------------------------------------------------------------

async function startTestServer() {
  const app = createApp();
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function call(baseUrl: string, method: string, route: string, body?: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, body: await response.json() as any };
}

test("the model a conversation is asked with becomes its own, and can be changed or cleared", async () => {
  resetConversations();
  const server = await startTestServer();
  try {
    const chosen = id();
    // A unit conversion is answered without the model, so this runs the same anywhere.
    await call(server.baseUrl, "POST", "/v1/assist", { mode: "general", message: "convert 7 km to miles", sessionId: "web", conversationId: chosen, model: "llama3.1:8b" });
    assert.equal(getConversation("web", chosen)?.model, "llama3.1:8b");

    const current = await call(server.baseUrl, "GET", "/v1/assist/conversation?sessionId=web");
    assert.equal(current.body.data.model, "llama3.1:8b");

    const changed = await call(server.baseUrl, "PATCH", `/v1/conversations/${chosen}`, { sessionId: "web", model: "qwen2.5-coder:7b" });
    assert.equal(changed.body.data.conversation.model, "qwen2.5-coder:7b");
    const cleared = await call(server.baseUrl, "PATCH", `/v1/conversations/${chosen}`, { sessionId: "web", model: null });
    assert.equal(cleared.body.data.conversation.model, undefined);

    assert.equal((await call(server.baseUrl, "PATCH", `/v1/conversations/${chosen}`, { sessionId: "web", model: "bad name;" })).status, 400);
  } finally {
    await server.close();
  }
});

test("a reply that no model wrote reports no context use", async () => {
  resetConversations();
  const server = await startTestServer();
  try {
    const answered = await call(server.baseUrl, "POST", "/v1/assist", { mode: "general", message: "convert 8 km to miles", sessionId: "web", conversationId: id() });
    assert.equal(answered.body.data.context, null);
  } finally {
    await server.close();
  }
});

test("the models route answers whether or not a model server is running", async () => {
  const server = await startTestServer();
  try {
    const listed = await call(server.baseUrl, "GET", "/v1/models");
    assert.equal(listed.status, 200);
    assert.ok(Array.isArray(listed.body.data.models));
    assert.ok(listed.body.data.defaultModel === null || typeof listed.body.data.defaultModel === "string");
  } finally {
    await server.close();
  }
});
