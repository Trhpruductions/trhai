import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

// See memory-controls.test.ts for why this must be set before createApp or
// assistMemoryStore is loaded, and what happened live when it was not. All
// five are set defensively — createApp() loads every store server.js wires
// up, regardless of which routes this file happens to exercise today.
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-assist-memory-"));
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");
const {
  maxMemoriesPerSession,
  recordMemoriesFromMessage,
  resetAssistMemory,
  retrieveSessionMemories
} = await import("../src/services/assistMemoryStore.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("records only new memories and reports what was written", () => {
  resetAssistMemory("s1");

  const first = recordMemoriesFromMessage("s1", "Remember that we deploy on Tuesdays.");
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "fact");

  // Duplicate suppression: the same claim must not be stored twice.
  const second = recordMemoriesFromMessage("s1", "Remember that we deploy on Tuesdays.");
  assert.equal(second.length, 0);
  assert.equal(retrieveSessionMemories("s1").length, 1);
});

test("keeps sessions isolated from each other", () => {
  resetAssistMemory();

  recordMemoriesFromMessage("session-a", "I prefer dark mode.");
  recordMemoriesFromMessage("session-b", "I prefer light mode.");

  assert.equal(retrieveSessionMemories("session-a").length, 1);
  assert.match(retrieveSessionMemories("session-a")[0].body, /dark/i);
  assert.match(retrieveSessionMemories("session-b")[0].body, /light/i);
});

test("returns nothing for an unknown session", () => {
  resetAssistMemory();
  assert.deepEqual(retrieveSessionMemories("never-seen"), []);
});

test("retrieval returns most recent memories first and respects the limit", () => {
  resetAssistMemory("s2");

  recordMemoriesFromMessage("s2", "Remember that alpha is first.");
  recordMemoriesFromMessage("s2", "Remember that beta is second.");
  recordMemoriesFromMessage("s2", "Remember that gamma is third.");

  const retrieved = retrieveSessionMemories("s2", 2);
  assert.equal(retrieved.length, 2);
  assert.match(retrieved[0].body, /gamma/i);
  assert.match(retrieved[1].body, /beta/i);
});

test("caps stored memories per session, dropping the oldest", () => {
  resetAssistMemory("s3");

  for (let index = 0; index < maxMemoriesPerSession + 10; index += 1) {
    recordMemoriesFromMessage("s3", `Remember that item number ${index} exists.`);
  }

  const all = retrieveSessionMemories("s3", 1000);
  assert.equal(all.length, maxMemoriesPerSession);
  // Newest survives, oldest evicted.
  assert.match(all[0].body, new RegExp(`item number ${maxMemoriesPerSession + 9}\\b`));
  assert.ok(!all.some((entry) => /item number 0\b/.test(entry.body)));
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

async function assist(baseUrl: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/v1/assist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "general", ...body })
  });
  const payload = await response.json() as {
    data?: {
      assistantMessage?: string;
      usedMemoryEntries?: number;
      savedMemoryEntries?: number;
    };
  };
  return { status: response.status, data: payload.data };
}

test("/v1/assist remembers a fact and uses it on a later turn", async () => {
  resetAssistMemory("e2e-session");
  const server = await startTestServer();

  try {
    const first = await assist(server.baseUrl, {
      sessionId: "e2e-session",
      message: "Remember that we standardized on Postgres."
    });
    assert.equal(first.data?.savedMemoryEntries, 1);

    const second = await assist(server.baseUrl, {
      sessionId: "e2e-session",
      message: "What database should I use?"
    });

    assert.equal(second.data?.usedMemoryEntries, 1);
    assert.equal(second.data?.savedMemoryEntries, 0);
    // The memory must actually reach the reply, not just the counter.
    assert.match(second.data?.assistantMessage ?? "", /Postgres/i);
  } finally {
    await server.close();
  }
});

test("/v1/assist skips memory entirely without a session id", async () => {
  const server = await startTestServer();

  try {
    const result = await assist(server.baseUrl, {
      message: "Remember that we standardized on Postgres."
    });

    assert.equal(result.status, 200);
    assert.equal(result.data?.savedMemoryEntries, 0);
    assert.equal(result.data?.usedMemoryEntries, 0);
  } finally {
    await server.close();
  }
});

test("/v1/assist rejects an unusable session id without failing the request", async () => {
  const server = await startTestServer();

  try {
    const tooLong = await assist(server.baseUrl, {
      sessionId: "x".repeat(500),
      message: "Remember that we use Redis."
    });

    assert.equal(tooLong.status, 200);
    assert.equal(tooLong.data?.savedMemoryEntries, 0);

    const wrongType = await assist(server.baseUrl, {
      sessionId: { nope: true },
      message: "Remember that we use Redis."
    });

    assert.equal(wrongType.status, 200);
    assert.equal(wrongType.data?.savedMemoryEntries, 0);
  } finally {
    await server.close();
  }
});

test("/v1/assist does not leak memory between sessions", async () => {
  resetAssistMemory();
  const server = await startTestServer();

  try {
    await assist(server.baseUrl, {
      sessionId: "tenant-a",
      message: "Remember that the admin password rotation is monthly."
    });

    const other = await assist(server.baseUrl, {
      sessionId: "tenant-b",
      message: "What is the rotation policy?"
    });

    assert.equal(other.data?.usedMemoryEntries, 0);
    assert.doesNotMatch(other.data?.assistantMessage ?? "", /rotation is monthly/i);
  } finally {
    await server.close();
  }
});
