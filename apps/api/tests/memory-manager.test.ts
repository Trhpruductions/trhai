import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

// The Memory workspace: remembering something on purpose, and reading back
// what is remembered with how much room there is.

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-memory-manager-"));
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");
const { maxMemoriesPerSession } = await import("../src/services/assistMemoryStore.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function startTestServer() {
  const server = createApp().listen(0);
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

test("remembering something on purpose stores it, once, and says so", async () => {
  const server = await startTestServer();
  try {
    const saved = await call(server.baseUrl, "POST", "/v1/assist/memory", { sessionId: "mm-a", text: "the DayZ server restarts at 4am" });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.data.status, "saved");
    assert.match(saved.body.data.memory.body, /restarts at 4am/);

    const again = await call(server.baseUrl, "POST", "/v1/assist/memory", { sessionId: "mm-a", text: "the DayZ server restarts at 4am" });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.status, "duplicate");

    const listed = await call(server.baseUrl, "GET", "/v1/assist/memory?sessionId=mm-a");
    assert.equal(listed.body.data.memories.length, 1);
    assert.equal(listed.body.data.limit, maxMemoriesPerSession);
    assert.ok(listed.body.data.audit.some((entry: any) => entry.action === "recorded"), "the save is in the history");
  } finally {
    await server.close();
  }
});

test("nothing to remember, or no identity, is refused", async () => {
  const server = await startTestServer();
  try {
    assert.equal((await call(server.baseUrl, "POST", "/v1/assist/memory", { sessionId: "mm-b", text: "   " })).status, 400);
    assert.equal((await call(server.baseUrl, "POST", "/v1/assist/memory", { text: "no session" })).status, 400);
    assert.equal((await call(server.baseUrl, "GET", "/v1/assist/memory?sessionId=mm-b")).body.data.memories.length, 0);
  } finally {
    await server.close();
  }
});

test("a memory told on purpose is filed by what it says, not as a bare fact", async () => {
  const server = await startTestServer();
  try {
    const kindOf = async (text: string) =>
      (await call(server.baseUrl, "POST", "/v1/assist/memory", { sessionId: "mm-kinds", text })).body.data.memory?.kind;
    assert.equal(await kindOf("I prefer short answers"), "preference");
    assert.equal(await kindOf("never deploy on Fridays"), "constraint");
    // Nothing more specific recognises this one, so it is a plain fact.
    assert.equal(await kindOf("the build server is called Atlas"), "fact");
  } finally {
    await server.close();
  }
});

test("one session's memories are not another's", async () => {
  const server = await startTestServer();
  try {
    await call(server.baseUrl, "POST", "/v1/assist/memory", { sessionId: "mm-owner", text: "my locker code is private" });
    assert.equal((await call(server.baseUrl, "GET", "/v1/assist/memory?sessionId=mm-stranger")).body.data.memories.length, 0);
  } finally {
    await server.close();
  }
});
