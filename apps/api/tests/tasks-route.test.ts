import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

// Set before createApp is imported — see memory-controls.test.ts for why:
// the store reads its file path at import time, and a static import would
// already have pulled in the real, un-isolated default path.
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-tasks-route-"));
process.env.ASSIST_TASKS_FILE = path.join(dataDir, "tasks.json");
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
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

test("task routes create, list, toggle and delete", async () => {
  const server = await startTestServer();
  try {
    const created = await fetch(`${server.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "route-session", title: "Write the release notes" })
    });
    const createdPayload = await created.json() as { data?: { task?: { id: string; title: string; done: boolean } } };
    assert.equal(created.status, 201);
    const task = createdPayload.data?.task;
    assert.ok(task, "expected a created task");
    assert.equal(task.title, "Write the release notes");
    assert.equal(task.done, false);

    const listed = await fetch(`${server.baseUrl}/v1/tasks?sessionId=route-session`);
    const listPayload = await listed.json() as { data?: { tasks?: unknown[] } };
    assert.equal(listPayload.data?.tasks?.length, 1);

    const toggled = await fetch(`${server.baseUrl}/v1/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "route-session", done: true })
    });
    const toggledPayload = await toggled.json() as { data?: { task?: { done: boolean } } };
    assert.equal(toggled.status, 200);
    assert.equal(toggledPayload.data?.task?.done, true);

    const deleted = await fetch(`${server.baseUrl}/v1/tasks/${task.id}?sessionId=route-session`, { method: "DELETE" });
    assert.equal(deleted.status, 204);

    const after = await fetch(`${server.baseUrl}/v1/tasks?sessionId=route-session`);
    const afterPayload = await after.json() as { data?: { tasks?: unknown[] } };
    assert.equal(afterPayload.data?.tasks?.length, 0);
  } finally {
    await server.close();
  }
});

test("a task with no title is refused, not silently accepted as empty", async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "route-empty-title" })
    });
    assert.equal(response.status, 400);
  } finally {
    await server.close();
  }
});

test("a request with no session id is refused rather than falling back to a shared bucket", async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Orphaned task" })
    });
    assert.equal(response.status, 400);
  } finally {
    await server.close();
  }
});

test("toggling or deleting a task that does not exist reports 404, not a silent success", async () => {
  const server = await startTestServer();
  try {
    const toggled = await fetch(`${server.baseUrl}/v1/tasks/nonexistent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "route-404", done: true })
    });
    assert.equal(toggled.status, 404);

    const deleted = await fetch(`${server.baseUrl}/v1/tasks/nonexistent?sessionId=route-404`, { method: "DELETE" });
    assert.equal(deleted.status, 404);
  } finally {
    await server.close();
  }
});
