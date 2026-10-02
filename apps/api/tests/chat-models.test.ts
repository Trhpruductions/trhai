import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LocalModelConfig } from "../src/services/localModel.js";

// A model per conversation, and how full the model's context window was -
// the two things the chat header shows next to the conversation's name.

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-chat-models-"));
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");
process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "ascend-chat-models-ws-"));

const { chatModelsFrom, isModelName, listChatModels, withChosenModel } = await import("../src/services/modelCatalog.js");
const { recordContextUse, takeContextUse } = await import("../src/services/contextUse.js");
const { runAgent } = await import("../src/services/agentLoop.js");
const { contextWindow } = await import("../src/services/localModel.js");
const { getConversation, resetConversations } = await import("../src/services/conversationStore.js");
const { createApp } = await import("../src/server.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const id = () => globalThis.crypto.randomUUID();

// ---- which models can hold a conversation ---------------------------------

test("the list leaves out the vision model and embedding models, and is sorted", () => {
  const models = chatModelsFrom([
    { name: "qwen2.5-coder:7b", size: 4_683_087_332, details: { family: "qwen2", parameter_size: "7.6B" } },
    { name: "qwen2.5vl:3b", details: { family: "qwen25vl" } },
    { name: "nomic-embed-text:latest", details: { family: "nomic-bert", families: ["nomic-bert"] } },
    { name: "llama3.1:8b", details: { family: "llama", parameter_size: "8.0B" } },
    { name: 42 } as never
  ], "qwen2.5vl:3b");
  assert.deepEqual(models.map((model) => model.name), ["llama3.1:8b", "qwen2.5-coder:7b"]);
  assert.deepEqual(models[1], { name: "qwen2.5-coder:7b", parameterSize: "7.6B", family: "qwen2", sizeBytes: 4_683_087_332 });
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
  const tags = { models: [{ name: "qwen2.5-coder:7b" }, { name: "llama3.1:8b" }, { name: "qwen2.5vl:3b" }] };
  const fetchTags = (async () => new Response(JSON.stringify(tags), { status: 200 })) as typeof fetch;
  const listed = await listChatModels({ baseUrl: "http://ollama", model: "qwen2.5-coder:7b", modelFromEnv: true, timeoutMs: 1000 }, fetchTags);
  assert.equal(listed.defaultModel, "qwen2.5-coder:7b");
  assert.deepEqual(listed.models.map((model) => model.name), ["llama3.1:8b", "qwen2.5-coder:7b"]);

  const down = (async () => { throw new Error("connection refused"); }) as typeof fetch;
  const nothing = await listChatModels({ baseUrl: "http://ollama", model: "x", modelFromEnv: true, timeoutMs: 1000 }, down);
  assert.deepEqual(nothing.models, []);
  assert.match(nothing.reason ?? "", /No local model server/);
});

// ---- how full the context window was ---------------------------------------

test("a measurement is reported once, then gone", () => {
  recordContextUse("s", { promptTokens: 7000, windowTokens: 16384 });
  assert.deepEqual(takeContextUse("s"), { promptTokens: 7000, windowTokens: 16384 });
  assert.equal(takeContextUse("s"), null, "never shown again for a later reply");
});

function fakeModel(reply: string) {
  return new Promise<{ server: Server; baseUrl: string }>((resolve) => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ model: "llama3.1:8b", message: { content: reply } }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

test("the agent loop records the prompt it actually sent, against the window it ran with", async () => {
  const { server, baseUrl } = await fakeModel("Paris.");
  try {
    const config: LocalModelConfig = { baseUrl, model: "llama3.1:8b", modelFromEnv: true, timeoutMs: 4000 };
    const result = await runAgent(config, "What is the capital of France?", { memories: [], knowledge: [], sessionId: "ctx-session" });
    assert.equal(result.ok, true);
    const use = takeContextUse("ctx-session");
    assert.ok(use, "nothing was recorded");
    assert.ok(use.promptTokens > 500, `a prompt with the rules in it is not ${use.promptTokens} tokens`);
    assert.equal(use.windowTokens, contextWindow(config));
  } finally {
    server.close();
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
