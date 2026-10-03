import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { fakeEngine, type ChatBody } from "./helpers/fakeEngine.js";

// Which model a summary is asked of, through the route.
//
// A summary of a saved document does not go through the agent loop: the
// service asks the model for it directly. That call sent the model's name
// exactly as the settings had it. With the models in TRH AI's own engine the
// name in an existing .env - "qwen2.5-coder:7b", Ollama's spelling - is not a
// name the engine answers to, and with nothing set at all the name was one no
// engine has. Chat turns were unaffected, which is how it went unnoticed: they
// ask the engine which model to use first. Every store the route touches is a
// temporary directory set before server.js loads.
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-summary-model-"));
process.env.ASCEND_WORKSPACE = mkdtempSync(path.join(tmpdir(), "ascend-summary-model-ws-"));
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
});

const summary = "The harbor opens at six, and the ferry leaves at seven.";

/**
 * Saves a document and asks for its summary, with `settings` in the
 * environment and an engine that has `models`. Returns the reply, and every
 * request the engine was sent for a model's words.
 */
async function summarized(sessionId: string, models: string[], settings: Record<string, string>) {
  const engine = await fakeEngine({ models, reply: { message: { content: summary } } });
  const env: Record<string, string | undefined> = { TRHAI_ENGINE_URL: engine.baseUrl, TRHAI_MODEL: undefined, OLLAMA_MODEL: undefined, ...settings };
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(env)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const app = createApp().listen(0, "127.0.0.1");
  await once(app, "listening");
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const post = (route: string, body: Record<string, unknown>) => fetch(`${base}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    const document = await post("/v1/knowledge", { sessionId, title: "Harbor Town Handbook", body: "The harbor opens at six. The ferry leaves at seven." });
    assert.equal(document.status, 201, "the document was saved");
    const response = await post("/v1/assist", { mode: "general", sessionId, message: "summarize the Harbor Town Handbook" });
    assert.equal(response.status, 200);
    const reply = ((await response.json()) as { data: { assistantMessage: string; model?: string } }).data;
    return { reply, chats: engine.chats as ChatBody[] };
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await engine.close();
  }
}

test("a summary is asked of the engine's name for the model a .env written under Ollama names", async () => {
  const { reply, chats } = await summarized("summary-old-name", ["qwen2.5-3b", "qwen2.5-coder-7b", "qwen3-8b"], { OLLAMA_MODEL: "qwen2.5-coder:7b" });
  assert.deepEqual(chats.map((chat) => chat.model), ["qwen2.5-coder-7b"], "one request, by the engine's name for that model");
  assert.ok(reply.assistantMessage.includes(summary), `the summary is the reply: ${reply.assistantMessage}`);
  assert.doesNotMatch(reply.assistantMessage, /could not be written|not found|not one of the models/i);
});

test("with no model named, a summary is written by the model a chat turn would use", async () => {
  // Nothing set, and the usual first choice is not installed: the next in the
  // order of preference answers, as it would a chat turn.
  const { reply, chats } = await summarized("summary-no-name", ["qwen2.5-3b", "qwen3-8b"], {});
  assert.deepEqual(chats.map((chat) => chat.model), ["qwen3-8b"]);
  assert.ok(reply.assistantMessage.includes(summary), `the summary is the reply: ${reply.assistantMessage}`);
});

test("a named model that is not installed does not stop a summary being written", async () => {
  const { reply, chats } = await summarized("summary-missing-name", ["qwen2.5-3b"], { TRHAI_MODEL: "mistral-7b" });
  assert.deepEqual(chats.map((chat) => chat.model), ["qwen2.5-3b"], "the model that is there, not a name the engine has no model for");
  assert.ok(reply.assistantMessage.includes(summary), `the summary is the reply: ${reply.assistantMessage}`);
});
