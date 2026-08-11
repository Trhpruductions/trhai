import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-conversation-"));
const conversationFile = path.join(dataDir, "conversations.json");
process.env.ASSIST_CONVERSATION_FILE = conversationFile;
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");

const {
  appendTurn,
  clearConversation,
  listTurns,
  maxTurnsPerKey,
  reloadConversationsFromDisk,
  resetConversations
} = await import("../src/services/conversationStore.js");
const { resetAccounts } = await import("../src/services/accounts.js");
const { resetRateLimits } = await import("../src/services/rateLimit.js");
const { createApp } = await import("../src/server.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("records turns in the order they were said", () => {
  resetConversations();
  appendTurn("k", "user", "first");
  appendTurn("k", "assistant", "second");

  assert.deepEqual(listTurns("k").map((t) => t.content), ["first", "second"]);
});

test("ignores empty turns", () => {
  resetConversations();
  assert.equal(appendTurn("k", "user", "   "), null);
  assert.deepEqual(listTurns("k"), []);
});

test("keys are isolated", () => {
  resetConversations();
  appendTurn("a", "user", "for a");
  appendTurn("b", "user", "for b");

  assert.deepEqual(listTurns("a").map((t) => t.content), ["for a"]);
  assert.deepEqual(listTurns("b").map((t) => t.content), ["for b"]);
});

test("caps turns, dropping the oldest", () => {
  resetConversations();
  for (let i = 0; i < maxTurnsPerKey + 10; i += 1) appendTurn("cap", "user", `turn ${i}`);

  const turns = listTurns("cap");
  assert.equal(turns.length, maxTurnsPerKey);
  assert.equal(turns[turns.length - 1].content, `turn ${maxTurnsPerKey + 9}`);
  assert.ok(!turns.some((t) => t.content === "turn 0"));
});

test("clearing removes the conversation", () => {
  resetConversations();
  appendTurn("clear", "user", "something");

  assert.equal(clearConversation("clear"), 1);
  assert.deepEqual(listTurns("clear"), []);
  assert.equal(clearConversation("clear"), 0);
});

test("conversations survive a restart", () => {
  resetConversations();
  appendTurn("durable", "user", "does this persist?");
  appendTurn("durable", "assistant", "it does");

  reloadConversationsFromDisk();

  assert.deepEqual(listTurns("durable").map((t) => t.content), ["does this persist?", "it does"]);
});

test("a corrupt file is survived rather than crashing", () => {
  resetConversations();
  appendTurn("x", "user", "before corruption");
  writeFileSync(conversationFile, "{ not json at all", "utf8");

  assert.doesNotThrow(() => reloadConversationsFromDisk());
  assert.deepEqual(listTurns("x"), []);
});

test("malformed turns are dropped without discarding good ones", () => {
  resetConversations();
  writeFileSync(conversationFile, JSON.stringify({
    version: 1,
    conversations: [{
      key: "mixed",
      turns: [
        { id: "1", role: "user", content: "kept", createdAt: new Date().toISOString() },
        { role: "user" },
        "nope"
      ]
    }]
  }), "utf8");

  reloadConversationsFromDisk();

  const turns = listTurns("mixed");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].content, "kept");
});

async function startTestServer() {
  const app = createApp();
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

async function assist(baseUrl: string, body: Record<string, unknown>, token?: string) {
  const response = await fetch(`${baseUrl}/v1/assist`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ mode: "general", ...body })
  });
  return await response.json() as any;
}

test("the assist endpoint records both sides of the exchange", async () => {
  resetConversations();
  const server = await startTestServer();

  try {
    await assist(server.baseUrl, { message: "Hello there", sessionId: "rec" });

    const listed = await (await fetch(`${server.baseUrl}/v1/assist/conversation?sessionId=rec`)).json() as any;
    const roles = listed.data.turns.map((t: any) => t.role);

    assert.deepEqual(roles, ["user", "assistant"]);
    assert.equal(listed.data.turns[0].content, "Hello there");
  } finally {
    await server.close();
  }
});

test("a conversation follows the account to a fresh browser", async () => {
  resetConversations();
  resetAccounts();
  resetRateLimits();
  const server = await startTestServer();

  try {
    const registered = await (await fetch(`${server.baseUrl}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "convo@example.com", password: "correct horse battery" })
    })).json() as any;
    const token = registered.data.token;

    await assist(server.baseUrl, { message: "The API runs on port 4000", sessionId: "browser-a" }, token);

    // A different anonymous session id, same account.
    const listed = await (await fetch(`${server.baseUrl}/v1/assist/conversation?sessionId=browser-b`, {
      headers: { Authorization: `Bearer ${token}` }
    })).json() as any;

    assert.equal(listed.data.turns[0].content, "The API runs on port 4000");
  } finally {
    await server.close();
  }
});

test("stored history is used when the client sends none", async () => {
  resetConversations();
  const server = await startTestServer();

  try {
    await assist(server.baseUrl, { message: "The API runs on port 4000", sessionId: "cont" });

    // No history field at all, as a freshly loaded browser would send.
    const followUp = await assist(server.baseUrl, {
      message: "What port does the API run on?",
      sessionId: "cont"
    });

    assert.ok(followUp.data.usedHistoryTurns > 0, "should ground on the stored transcript");
    assert.match(followUp.data.assistantMessage, /port 4000/);
  } finally {
    await server.close();
  }
});

test("one session cannot read another's conversation", async () => {
  resetConversations();
  const server = await startTestServer();

  try {
    await assist(server.baseUrl, { message: "private to owner", sessionId: "owner" });

    const other = await (await fetch(`${server.baseUrl}/v1/assist/conversation?sessionId=stranger`)).json() as any;
    assert.deepEqual(other.data.turns, []);
  } finally {
    await server.close();
  }
});

test("the endpoint can clear a conversation", async () => {
  resetConversations();
  const server = await startTestServer();

  try {
    await assist(server.baseUrl, { message: "to be cleared", sessionId: "wipe" });

    const deleted = await fetch(`${server.baseUrl}/v1/assist/conversation?sessionId=wipe`, { method: "DELETE" });
    assert.equal(deleted.status, 200);

    const listed = await (await fetch(`${server.baseUrl}/v1/assist/conversation?sessionId=wipe`)).json() as any;
    assert.deepEqual(listed.data.turns, []);
  } finally {
    await server.close();
  }
});

test("the conversation endpoints require an identity", async () => {
  const server = await startTestServer();

  try {
    assert.equal((await fetch(`${server.baseUrl}/v1/assist/conversation`)).status, 400);
    assert.equal(
      (await fetch(`${server.baseUrl}/v1/assist/conversation`, { method: "DELETE" })).status,
      400
    );
  } finally {
    await server.close();
  }
});
