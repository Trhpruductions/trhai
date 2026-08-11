import test from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { createApp } from "../src/server.js";
import {
  forgetAllMemories,
  forgetMemory,
  getMemoryAudit,
  listSessionMemories,
  maxMemoriesPerSession,
  recordMemoriesFromMessage,
  relabelMemory,
  resetAssistMemory,
  retrieveSessionMemories,
  setMemoryPinned
} from "../src/services/assistMemoryStore.js";

test("forgetting a memory removes it from retrieval immediately", () => {
  resetAssistMemory("c1");
  const [entry] = recordMemoriesFromMessage("c1", "Remember that the API key rotates weekly.");

  assert.equal(retrieveSessionMemories("c1").length, 1);
  assert.equal(forgetMemory("c1", entry.id), true);
  assert.equal(retrieveSessionMemories("c1").length, 0);
});

test("forgetting an unknown memory reports failure", () => {
  resetAssistMemory("c2");
  assert.equal(forgetMemory("c2", "does-not-exist"), false);
});

test("pinned memories rank ahead of newer unpinned ones", () => {
  resetAssistMemory("c3");
  const [oldest] = recordMemoriesFromMessage("c3", "Remember that alpha matters most.");
  recordMemoriesFromMessage("c3", "Remember that beta is newer.");
  recordMemoriesFromMessage("c3", "Remember that gamma is newest.");

  // Without pinning, recency wins.
  assert.match(retrieveSessionMemories("c3")[0].body, /gamma/i);

  setMemoryPinned("c3", oldest.id, true);
  assert.match(retrieveSessionMemories("c3")[0].body, /alpha/i);
});

test("pinned memories survive the per-session cap", () => {
  resetAssistMemory("c4");
  const [pinned] = recordMemoriesFromMessage("c4", "Remember that this one must never be evicted.");
  setMemoryPinned("c4", pinned.id, true);

  for (let index = 0; index < maxMemoriesPerSession + 20; index += 1) {
    recordMemoriesFromMessage("c4", `Remember that filler entry ${index} exists.`);
  }

  const all = listSessionMemories("c4");
  assert.ok(all.some((entry) => entry.id === pinned.id), "pinned entry was evicted");
  assert.ok(all.length <= maxMemoriesPerSession);
});

test("unpinning restores normal recency ordering", () => {
  resetAssistMemory("c5");
  const [first] = recordMemoriesFromMessage("c5", "Remember that alpha is old.");
  recordMemoriesFromMessage("c5", "Remember that omega is new.");

  setMemoryPinned("c5", first.id, true);
  assert.match(retrieveSessionMemories("c5")[0].body, /alpha/i);

  setMemoryPinned("c5", first.id, false);
  assert.match(retrieveSessionMemories("c5")[0].body, /omega/i);
});

test("relabeling changes the title but preserves the extracted body", () => {
  resetAssistMemory("c6");
  const [entry] = recordMemoriesFromMessage("c6", "Remember that we deploy behind a feature flag.");

  const updated = relabelMemory("c6", entry.id, "  Deployment policy  ");

  assert.equal(updated?.title, "Deployment policy");
  assert.match(updated?.body ?? "", /feature flag/i);
  assert.ok(updated?.editedAt);
});

test("relabeling rejects a blank title", () => {
  resetAssistMemory("c7");
  const [entry] = recordMemoriesFromMessage("c7", "Remember that blanks are invalid.");

  assert.equal(relabelMemory("c7", entry.id, "   "), null);
});

test("clearing removes every memory for the session only", () => {
  resetAssistMemory();
  recordMemoriesFromMessage("keep", "Remember that this survives.");
  recordMemoriesFromMessage("wipe", "Remember that this goes away.");

  assert.equal(forgetAllMemories("wipe"), 1);
  assert.equal(listSessionMemories("wipe").length, 0);
  assert.equal(listSessionMemories("keep").length, 1);
});

test("control actions are written to the audit trail", () => {
  resetAssistMemory("c8");
  const [entry] = recordMemoriesFromMessage("c8", "Remember that auditing matters.");
  setMemoryPinned("c8", entry.id, true);
  relabelMemory("c8", entry.id, "Auditing");
  forgetMemory("c8", entry.id);

  const actions = getMemoryAudit("c8").map((item) => item.action);

  // Newest first.
  assert.deepEqual(actions, ["forgotten", "relabeled", "pinned", "recorded"]);
});

test("audit is scoped per session", () => {
  resetAssistMemory();
  recordMemoriesFromMessage("audit-a", "Remember that a happened.");
  recordMemoriesFromMessage("audit-b", "Remember that b happened.");

  const scoped = getMemoryAudit("audit-a");
  assert.equal(scoped.length, 1);
  assert.match(scoped[0].detail, /a happened/i);
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

test("memory control routes list, pin, relabel and forget", async () => {
  resetAssistMemory("route-session");
  const server = await startTestServer();

  try {
    await fetch(`${server.baseUrl}/v1/assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "general",
        sessionId: "route-session",
        message: "Remember that we release on Thursdays."
      })
    });

    const listed = await fetch(`${server.baseUrl}/v1/assist/memory?sessionId=route-session`);
    const listPayload = await listed.json() as { data?: { memories?: Array<{ id: string; title: string }> } };
    const memory = listPayload.data?.memories?.[0];
    assert.ok(memory, "expected a stored memory");

    const patched = await fetch(`${server.baseUrl}/v1/assist/memory/${memory.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "route-session", pinned: true, title: "Release cadence" })
    });
    const patchPayload = await patched.json() as { data?: { memory?: { pinned: boolean; title: string } } };
    assert.equal(patched.status, 200);
    assert.equal(patchPayload.data?.memory?.pinned, true);
    assert.equal(patchPayload.data?.memory?.title, "Release cadence");

    const deleted = await fetch(
      `${server.baseUrl}/v1/assist/memory/${memory.id}?sessionId=route-session`,
      { method: "DELETE" }
    );
    assert.equal(deleted.status, 200);

    const after = await fetch(`${server.baseUrl}/v1/assist/memory?sessionId=route-session`);
    const afterPayload = await after.json() as { data?: { memories?: unknown[] } };
    assert.equal(afterPayload.data?.memories?.length, 0);
  } finally {
    await server.close();
  }
});

test("memory routes require a session id", async () => {
  const server = await startTestServer();

  try {
    const listed = await fetch(`${server.baseUrl}/v1/assist/memory`);
    assert.equal(listed.status, 400);

    const patched = await fetch(`${server.baseUrl}/v1/assist/memory/abc`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true })
    });
    assert.equal(patched.status, 400);

    const deleted = await fetch(`${server.baseUrl}/v1/assist/memory/abc`, { method: "DELETE" });
    assert.equal(deleted.status, 400);
  } finally {
    await server.close();
  }
});

test("one session cannot forget another session's memory", async () => {
  resetAssistMemory();
  const server = await startTestServer();

  try {
    const [entry] = recordMemoriesFromMessage("owner", "Remember that this belongs to owner.");

    const attacked = await fetch(
      `${server.baseUrl}/v1/assist/memory/${entry.id}?sessionId=attacker`,
      { method: "DELETE" }
    );

    assert.equal(attacked.status, 404);
    assert.equal(listSessionMemories("owner").length, 1);
  } finally {
    await server.close();
  }
});
