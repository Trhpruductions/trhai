import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { fakeEngine } from "./helpers/fakeEngine.js";

// The active agent, end to end: an id on the request, looked up in the shared
// catalogue by the route, and written into the system prompt the model is
// sent. Every store the route touches is pointed at a temporary directory
// before server.js loads, as in assist-context.test.ts.
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-assist-agent-"));
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** A stand-in engine that records every chat request and answers each one. */
function standInModel() {
  return fakeEngine({ reply: { message: { content: "Keep each message short and say what to do next." } } });
}

async function ask(body: Record<string, unknown>) {
  const model = await standInModel();
  const previous = process.env.TRHAI_ENGINE_URL;
  process.env.TRHAI_ENGINE_URL = model.baseUrl;
  const app = createApp().listen(0, "127.0.0.1");
  await once(app, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/v1/assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "general", message: "Explain what makes an error message readable.", ...body })
    });
    assert.equal(response.status, 200);
    const system = model.chats[0]?.messages?.find((message) => message.role === "system")?.content ?? "";
    return { system, chats: model.chats.length };
  } finally {
    if (previous === undefined) delete process.env.TRHAI_ENGINE_URL;
    else process.env.TRHAI_ENGINE_URL = previous;
    await new Promise<void>((resolve) => app.close(() => resolve()));
    model.server.close();
  }
}

test("an agent named on the request is in the system prompt the model is sent", async () => {
  const { system, chats } = await ask({ agentId: "programmer" });
  assert.ok(chats > 0, "the request reached the model");
  assert.match(system, /work as Ada, a programmer\./);
  // The catalogue's own description and focus, word for word.
  assert.match(system, /explains what a failure is actually telling you\./);
  assert.match(system, /Keep in view: Files, failures, and the smallest change that fixes them\./);
});

test("an agent's own limits travel with it", async () => {
  const { system } = await ask({ agentId: "financial-advisor" });
  assert.match(system, /work as Ledger, a financial advisor\./);
  assert.match(system, /Organizes numbers and frames tradeoffs\. Does not recommend investments\./);
});

test("no agent, or one the catalogue does not know, sends no persona at all", async () => {
  for (const body of [{}, { agentId: "not-a-real-agent" }, { agentId: 42 }, { agentId: "" }]) {
    const { system, chats } = await ask(body);
    assert.ok(chats > 0, "the request reached the model");
    assert.doesNotMatch(system, /work as/, `no persona for ${JSON.stringify(body)}`);
  }
});
