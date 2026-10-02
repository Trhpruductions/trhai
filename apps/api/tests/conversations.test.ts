import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

// Conversations: many per account, each with its own title, pin, archive flag
// and turns - and everything written for the single transcript still working.

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-conversations-"));
const conversationFile = path.join(dataDir, "conversations.json");
process.env.ASSIST_CONVERSATION_FILE = conversationFile;
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const store = await import("../src/services/conversationStore.js");
const { createApp } = await import("../src/server.js");
const {
  appendTurn, clearConversation, currentConversationId, deleteConversation, dropLastExchange, getConversation,
  isConversationId, listConversations, listTurns, maxConversationsPerKey, reloadConversationsFromDisk,
  resetConversations, titleFrom, updateConversation
} = store;

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
const id = () => globalThis.crypto.randomUUID();

// ---- the store ---------------------------------------------------------------

test("conversations are kept apart by id", () => {
  resetConversations();
  const a = id();
  const b = id();
  appendTurn("k", "user", "about the server", undefined, a);
  appendTurn("k", "user", "about dinner", undefined, b);
  assert.deepEqual(listTurns("k", undefined, a).map((turn) => turn.content), ["about the server"]);
  assert.deepEqual(listTurns("k", undefined, b).map((turn) => turn.content), ["about dinner"]);
});

test("a turn with no conversation named continues the one used most recently", async () => {
  resetConversations();
  const older = id();
  const newer = id();
  appendTurn("k", "user", "first", undefined, older);
  await tick();
  appendTurn("k", "user", "second", undefined, newer);
  appendTurn("k", "assistant", "carried on");
  assert.equal(currentConversationId("k"), newer);
  assert.deepEqual(listTurns("k", undefined, newer).map((turn) => turn.content), ["second", "carried on"]);
});

test("a conversation is named from its first question, and a name the user gives sticks", () => {
  resetConversations();
  const c = id();
  appendTurn("k", "user", "How do I make the DayZ server restart every night at 4am without kicking players mid-raid?", undefined, c);
  const auto = getConversation("k", c)?.title ?? "";
  assert.ok(auto.length <= 61 && auto.endsWith("…"), auto);
  assert.ok(auto.startsWith("How do I make the DayZ server restart"), auto);

  updateConversation("k", c, { title: "  Nightly   restarts " });
  appendTurn("k", "user", "and on Sundays?", undefined, c);
  assert.equal(getConversation("k", c)?.title, "Nightly restarts");
  assert.equal(titleFrom("**Hi** there\nsecond line\n[2 images attached]"), "Hi there");
});

test("pinned conversations lead the list, then the most recently used", async () => {
  resetConversations();
  const old = id();
  const mid = id();
  const fresh = id();
  appendTurn("k", "user", "old", undefined, old);
  await tick();
  appendTurn("k", "user", "mid", undefined, mid);
  await tick();
  appendTurn("k", "user", "fresh", undefined, fresh);
  updateConversation("k", old, { pinned: true });
  assert.deepEqual(listConversations("k").map((entry) => entry.id), [old, fresh, mid]);
  // Pinning is not activity: the order among the rest is unchanged.
  assert.equal(currentConversationId("k"), fresh);
});

test("archived conversations leave the list until asked for, and come back when continued", () => {
  resetConversations();
  const c = id();
  appendTurn("k", "user", "keep this for later", undefined, c);
  updateConversation("k", c, { archived: true });
  assert.deepEqual(listConversations("k"), []);
  assert.deepEqual(listConversations("k", { archived: true }).map((entry) => entry.id), [c]);
  assert.equal(currentConversationId("k"), null);

  appendTurn("k", "user", "picking this back up", undefined, c);
  assert.deepEqual(listConversations("k").map((entry) => entry.id), [c]);
});

test("search finds a conversation by what was said, and shows where", () => {
  resetConversations();
  const c = id();
  appendTurn("k", "user", "What is my router's admin page?", undefined, c);
  appendTurn("k", "assistant", "It is usually at 192.168.0.1, and the default password is on the sticker underneath.", undefined, c);
  appendTurn("k", "user", "unrelated", undefined, id());

  const found = listConversations("k", { query: "STICKER" });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, c);
  assert.match(found[0].match ?? "", /sticker/);
  assert.deepEqual(listConversations("k", { query: "router's admin" }).map((entry) => entry.match), [undefined]);
  assert.deepEqual(listConversations("k", { query: "nothing like this" }), []);
});

test("an old single-transcript file becomes one conversation, with an id that stays put", () => {
  resetConversations();
  writeFileSync(conversationFile, JSON.stringify({
    version: 1,
    conversations: [{
      key: "legacy",
      turns: [
        { id: "1", role: "user", content: "What port does the API use?", createdAt: "2026-09-01T10:00:00.000Z" },
        { id: "2", role: "assistant", content: "4000.", createdAt: "2026-09-01T10:00:05.000Z" }
      ]
    }]
  }), "utf8");

  reloadConversationsFromDisk();
  const [only] = listConversations("legacy");
  assert.match(only.id, /^legacy-[0-9a-f]{16}$/);
  assert.equal(only.title, "What port does the API use?");
  assert.equal(only.updatedAt, "2026-09-01T10:00:05.000Z");
  assert.deepEqual(listTurns("legacy").map((turn) => turn.content), ["What port does the API use?", "4000."]);

  reloadConversationsFromDisk();
  assert.equal(listConversations("legacy")[0].id, only.id);
});

test("the new shape survives a restart, flags and all", () => {
  resetConversations();
  const c = id();
  appendTurn("k", "user", "remember the pin", undefined, c);
  updateConversation("k", c, { pinned: true, title: "Pinned one" });
  reloadConversationsFromDisk();
  const [entry] = listConversations("k");
  assert.equal(entry.id, c);
  assert.equal(entry.pinned, true);
  assert.equal(entry.title, "Pinned one");
});

test("regenerating takes back the last exchange - and nothing else", () => {
  resetConversations();
  const c = id();
  appendTurn("k", "user", "first question", undefined, c);
  appendTurn("k", "assistant", "first answer", undefined, c);
  appendTurn("k", "user", "second question\n[1 image attached]", undefined, c);
  appendTurn("k", "assistant", "second answer", undefined, c);

  assert.equal(dropLastExchange("k", c, "a different question"), false);
  assert.equal(dropLastExchange("k", c, "second question"), true);
  assert.deepEqual(listTurns("k", undefined, c).map((turn) => turn.content), ["first question", "first answer"]);
  assert.equal(dropLastExchange("k", id(), "first question"), false, "an unknown conversation is left alone");
  assert.equal(listConversations("k").length, 1, "and is not created by asking");
});

test("deleting removes one; clearing without an id removes the current one", async () => {
  resetConversations();
  const a = id();
  const b = id();
  appendTurn("k", "user", "a", undefined, a);
  await tick();
  appendTurn("k", "user", "b", undefined, b);

  assert.equal(deleteConversation("k", a), true);
  assert.equal(deleteConversation("k", a), false);
  assert.equal(clearConversation("k"), 1);
  assert.deepEqual(listConversations("k"), []);
});

test("conversation ids are checked, not trusted", () => {
  for (const bad of ["", "short", "../../etc/passwd", "has space in it", "a".repeat(65), 42, null, { id: "x" }]) {
    assert.equal(isConversationId(bad), false, String(bad));
  }
  assert.equal(isConversationId(id()), true);
  assert.equal(isConversationId("legacy-0123456789abcdef"), true);
});

test("past the per-account cap, the least recently used unpinned conversation goes", () => {
  resetConversations();
  const keepMe = id();
  appendTurn("cap", "user", "pinned and oldest", undefined, keepMe);
  updateConversation("cap", keepMe, { pinned: true });
  for (let i = 0; i < maxConversationsPerKey; i += 1) appendTurn("cap", "user", `chat ${i}`, undefined, id());

  const listed = listConversations("cap");
  assert.equal(listed.length, maxConversationsPerKey);
  assert.ok(listed.some((entry) => entry.id === keepMe), "the pinned one stays");
  assert.ok(!listed.some((entry) => entry.title === "chat 0"), "the oldest unpinned one went");
});

// ---- the API -----------------------------------------------------------------

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

async function call(baseUrl: string, method: string, route: string, body?: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, body: await response.json() as any };
}

// Unit conversions are answered on this PC without the model, so these run the
// same with or without Ollama.
const ask = (baseUrl: string, body: Record<string, unknown>) =>
  call(baseUrl, "POST", "/v1/assist", { mode: "general", ...body });

test("a new chat's first message creates its conversation under the id the app chose", async () => {
  resetConversations();
  const server = await startTestServer();
  try {
    const chosen = id();
    const answered = await ask(server.baseUrl, { message: "convert 10 km to miles", sessionId: "web", conversationId: chosen });
    assert.equal(answered.body.data.conversationId, chosen);

    const listed = await call(server.baseUrl, "GET", "/v1/conversations?sessionId=web");
    assert.deepEqual(listed.body.data.conversations.map((entry: any) => [entry.id, entry.title, entry.turnCount]),
      [[chosen, "convert 10 km to miles", 2]]);

    const opened = await call(server.baseUrl, "GET", `/v1/conversations/${chosen}?sessionId=web`);
    assert.deepEqual(opened.body.data.conversation.turns.map((turn: any) => turn.role), ["user", "assistant"]);
  } finally {
    await server.close();
  }
});

test("the streamed route says which conversation the reply went into", async () => {
  resetConversations();
  const server = await startTestServer();
  try {
    const chosen = id();
    const response = await fetch(`${server.baseUrl}/v1/assist/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "general", message: "convert 3 kg to pounds", sessionId: "web", conversationId: chosen })
    });
    const text = await response.text();
    const done = /event: done\ndata: (.+)/.exec(text)?.[1];
    assert.ok(done, "no done event");
    assert.equal(JSON.parse(done).conversationId, chosen);
    assert.equal(listTurns("web", undefined, chosen).length, 2);
  } finally {
    await server.close();
  }
});

test("rename, pin, archive and delete through the API", async () => {
  resetConversations();
  const server = await startTestServer();
  try {
    const chosen = id();
    await ask(server.baseUrl, { message: "convert 5 miles to km", sessionId: "web", conversationId: chosen });

    const renamed = await call(server.baseUrl, "PATCH", `/v1/conversations/${chosen}`, { sessionId: "web", title: "Distances", pinned: true });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.conversation.title, "Distances");
    assert.equal(renamed.body.data.conversation.pinned, true);

    await call(server.baseUrl, "PATCH", `/v1/conversations/${chosen}`, { sessionId: "web", archived: true });
    assert.deepEqual((await call(server.baseUrl, "GET", "/v1/conversations?sessionId=web")).body.data.conversations, []);
    const archived = await call(server.baseUrl, "GET", "/v1/conversations?sessionId=web&archived=1");
    assert.equal(archived.body.data.conversations[0].id, chosen);

    const searched = await call(server.baseUrl, "GET", "/v1/conversations?sessionId=web&archived=1&q=distan");
    assert.equal(searched.body.data.conversations.length, 1);

    assert.equal((await call(server.baseUrl, "DELETE", `/v1/conversations/${chosen}?sessionId=web`)).status, 200);
    assert.equal((await call(server.baseUrl, "GET", `/v1/conversations/${chosen}?sessionId=web`)).status, 404);
  } finally {
    await server.close();
  }
});

test("another session cannot read, change or delete a conversation", async () => {
  resetConversations();
  const server = await startTestServer();
  try {
    const chosen = id();
    await ask(server.baseUrl, { message: "convert 1 km to miles", sessionId: "owner", conversationId: chosen });

    assert.equal((await call(server.baseUrl, "GET", `/v1/conversations/${chosen}?sessionId=stranger`)).status, 404);
    assert.equal((await call(server.baseUrl, "PATCH", `/v1/conversations/${chosen}`, { sessionId: "stranger", pinned: true })).status, 404);
    assert.equal((await call(server.baseUrl, "DELETE", `/v1/conversations/${chosen}?sessionId=stranger`)).status, 404);
    assert.deepEqual((await call(server.baseUrl, "GET", "/v1/conversations?sessionId=stranger")).body.data.conversations, []);
    assert.equal(listConversations("owner")[0].pinned, false, "the owner's conversation is untouched");
  } finally {
    await server.close();
  }
});

test("bad requests are refused rather than half-applied", async () => {
  resetConversations();
  const server = await startTestServer();
  try {
    const chosen = id();
    await ask(server.baseUrl, { message: "convert 2 km to miles", sessionId: "web", conversationId: chosen });

    assert.equal((await call(server.baseUrl, "PATCH", `/v1/conversations/${chosen}`, { sessionId: "web", title: "   " })).status, 400);
    assert.equal((await call(server.baseUrl, "PATCH", `/v1/conversations/${chosen}`, { sessionId: "web", pinned: "yes" })).status, 400);
    assert.equal((await call(server.baseUrl, "GET", "/v1/conversations/not!an!id?sessionId=web")).status, 404);
    assert.equal((await call(server.baseUrl, "GET", "/v1/conversations")).status, 400, "no identity, no list");
    assert.equal(listConversations("web")[0].title, "convert 2 km to miles", "nothing was changed");
  } finally {
    await server.close();
  }
});

test("a regenerated answer replaces the one before it", async () => {
  resetConversations();
  const server = await startTestServer();
  try {
    const chosen = id();
    await ask(server.baseUrl, { message: "convert 4 km to miles", sessionId: "web", conversationId: chosen });
    await ask(server.baseUrl, { message: "convert 4 km to miles", sessionId: "web", conversationId: chosen, regenerate: true });
    assert.equal(listTurns("web", undefined, chosen).length, 2);
  } finally {
    await server.close();
  }
});

test("reading the current conversation says which one it is", async () => {
  resetConversations();
  const server = await startTestServer();
  try {
    const chosen = id();
    await ask(server.baseUrl, { message: "convert 6 km to miles", sessionId: "web", conversationId: chosen });
    const current = await call(server.baseUrl, "GET", "/v1/assist/conversation?sessionId=web");
    assert.equal(current.body.data.conversationId, chosen);
    assert.equal(current.body.data.turns.length, 2);
  } finally {
    await server.close();
  }
});
