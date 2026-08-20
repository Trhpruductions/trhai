import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

// createApp() below starts a real server and posts to /v1/assist through it,
// which can write through every persisted store server.js touches. Each
// store reads its file path at import time, so this has to be set — and
// createApp imported dynamically — before any of it loads. See
// memory-controls.test.ts for what happened live when a test file skipped
// this and wrote through the default path instead of an isolated one.
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-assist-context-"));
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");
const {
  maxAssistHistoryContentLength,
  maxAssistHistoryTurns,
  normalizeAssistHistory
} = await import("../src/services/assistContext.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("normalizeAssistHistory keeps valid turns and drops junk", () => {
  const turns = normalizeAssistHistory([
    { role: "user", content: "first" },
    { role: "system", content: "should be dropped" },
    { role: "assistant", content: "second" },
    { role: "user", content: "   " },
    { role: "user", content: 42 },
    null,
    "nope"
  ]);

  assert.deepEqual(turns, [
    { role: "user", content: "first" },
    { role: "assistant", content: "second" }
  ]);
});

test("normalizeAssistHistory returns an empty list for non-array input", () => {
  assert.deepEqual(normalizeAssistHistory(undefined), []);
  assert.deepEqual(normalizeAssistHistory(null), []);
  assert.deepEqual(normalizeAssistHistory("user: hi"), []);
  assert.deepEqual(normalizeAssistHistory({ role: "user", content: "hi" }), []);
});

test("normalizeAssistHistory caps turn count and keeps the most recent", () => {
  const input = Array.from({ length: maxAssistHistoryTurns + 8 }, (_unused, index) => ({
    role: "user" as const,
    content: `turn-${index}`
  }));

  const turns = normalizeAssistHistory(input);

  assert.equal(turns.length, maxAssistHistoryTurns);
  assert.equal(turns[turns.length - 1].content, `turn-${input.length - 1}`);
  assert.equal(turns[0].content, `turn-${input.length - maxAssistHistoryTurns}`);
});

test("normalizeAssistHistory truncates oversized turn content", () => {
  const turns = normalizeAssistHistory([
    { role: "user", content: "x".repeat(maxAssistHistoryContentLength + 500) }
  ]);

  assert.equal(turns[0].content.length, maxAssistHistoryContentLength);
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

test("/v1/assist threads conversation history into the reply", async () => {
  const server = await startTestServer();

  try {
    const response = await fetch(`${server.baseUrl}/v1/assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "general",
        message: "What did we decide?",
        history: [
          { role: "user", content: "We need a launch checklist" },
          { role: "assistant", content: "I can help outline the plan." }
        ]
      })
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      data?: { assistantMessage?: string; usedHistoryTurns?: number; sentHistoryTurns?: number };
    };

    // `sentHistoryTurns` is what was threaded through; `usedHistoryTurns` counts
    // only turns the reply was actually grounded on, which may legitimately be 0.
    assert.equal(payload.data?.sentHistoryTurns, 2);
    assert.ok((payload.data?.assistantMessage ?? "").length > 0);
  } finally {
    await server.close();
  }
});

test("/v1/assist reports zero history when none is supplied", async () => {
  const server = await startTestServer();

  try {
    const response = await fetch(`${server.baseUrl}/v1/assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "general", message: "Standalone question" })
    });

    const payload = await response.json() as {
      data?: { assistantMessage?: string; usedHistoryTurns?: number; sentHistoryTurns?: number };
    };

    assert.equal(payload.data?.usedHistoryTurns, 0);
    assert.ok((payload.data?.assistantMessage ?? "").length > 0);
  } finally {
    await server.close();
  }
});

test("/v1/assist ignores malformed history instead of failing the request", async () => {
  const server = await startTestServer();

  try {
    const response = await fetch(`${server.baseUrl}/v1/assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "general",
        message: "Still works",
        history: "not-an-array"
      })
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as { data?: { usedHistoryTurns?: number } };
    assert.equal(payload.data?.usedHistoryTurns, 0);
  } finally {
    await server.close();
  }
});

test("/v1/assist still rejects an empty message", async () => {
  const server = await startTestServer();

  try {
    const response = await fetch(`${server.baseUrl}/v1/assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "general", message: "   " })
    });

    assert.equal(response.status, 400);
  } finally {
    await server.close();
  }
});
