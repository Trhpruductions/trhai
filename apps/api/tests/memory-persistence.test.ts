import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The store reads its file path from the environment at import time, so this must
// be set before the module is loaded.
const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-memory-"));
const memoryFile = path.join(dataDir, "assist-memory.json");
process.env.ASSIST_MEMORY_FILE = memoryFile;

const {
  forgetMemory,
  getMemoryAudit,
  listSessionMemories,
  recordMemoriesFromMessage,
  recordSingleMemory,
  relabelMemory,
  reloadAssistMemoryFromDisk,
  resetAssistMemory,
  setMemoryPinned
} = await import("../src/services/assistMemoryStore.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("memory survives a restart", () => {
  resetAssistMemory();
  recordMemoriesFromMessage("durable", "Remember that we standardized on Postgres.");

  // Simulate the API process going away and coming back.
  reloadAssistMemoryFromDisk();

  const restored = listSessionMemories("durable");
  assert.equal(restored.length, 1);
  assert.match(restored[0].body, /Postgres/i);
});

test("the pinned flag and edited label survive a restart", () => {
  resetAssistMemory();
  const [entry] = recordMemoriesFromMessage("durable2", "Remember that deploys are Thursday.");
  setMemoryPinned("durable2", entry.id, true);
  relabelMemory("durable2", entry.id, "Deploy cadence");

  reloadAssistMemoryFromDisk();

  const [restored] = listSessionMemories("durable2");
  assert.equal(restored.pinned, true);
  assert.equal(restored.title, "Deploy cadence");
  assert.ok(restored.editedAt);
});

test("forgetting a memory also removes it from disk", () => {
  resetAssistMemory();
  const [entry] = recordMemoriesFromMessage("durable3", "Remember that this will be deleted.");
  assert.equal(forgetMemory("durable3", entry.id), true);

  reloadAssistMemoryFromDisk();

  assert.deepEqual(listSessionMemories("durable3"), []);
});

test("sessions stay isolated across a restart", () => {
  resetAssistMemory();
  recordMemoriesFromMessage("tenant-a", "Remember that alpha is secret.");
  recordMemoriesFromMessage("tenant-b", "Remember that beta is separate.");

  reloadAssistMemoryFromDisk();

  assert.equal(listSessionMemories("tenant-a").length, 1);
  assert.match(listSessionMemories("tenant-a")[0].body, /alpha/i);
  assert.match(listSessionMemories("tenant-b")[0].body, /beta/i);
});

test("the audit trail survives a restart", () => {
  resetAssistMemory();
  const [entry] = recordMemoriesFromMessage("durable4", "Remember that auditing persists.");
  setMemoryPinned("durable4", entry.id, true);

  reloadAssistMemoryFromDisk();

  const actions = getMemoryAudit("durable4").map((item) => item.action);
  assert.deepEqual(actions, ["pinned", "recorded"]);
});

test("a corrupt file is survived rather than crashing the API", () => {
  resetAssistMemory();
  recordMemoriesFromMessage("durable5", "Remember that this file gets corrupted.");

  writeFileSync(memoryFile, "{ this is not valid json", "utf8");

  assert.doesNotThrow(() => reloadAssistMemoryFromDisk());
  assert.deepEqual(listSessionMemories("durable5"), []);
});

test("malformed entries are dropped without discarding good ones", () => {
  resetAssistMemory();
  writeFileSync(memoryFile, JSON.stringify({
    version: 1,
    sessions: [{
      key: "mixed",
      memories: [
        { id: "good", title: "Real", body: "A real memory", kind: "fact", confidence: 1, rule: "r", createdAt: new Date().toISOString(), pinned: false },
        { nope: true },
        "not-an-object"
      ]
    }],
    audit: []
  }), "utf8");

  reloadAssistMemoryFromDisk();

  const rows = listSessionMemories("mixed");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "good");
});

test("writes leave no temp file behind", () => {
  resetAssistMemory();
  recordMemoriesFromMessage("durable6", "Remember that writes are atomic.");

  assert.ok(existsSync(memoryFile));
  assert.ok(!existsSync(`${memoryFile}.tmp`), "temp file should be renamed, not left in place");
  const parsed = JSON.parse(readFileSync(memoryFile, "utf8"));
  assert.equal(parsed.version, 1);
});

// recordSingleMemory backs the "remember" tool. Unlike recordMemoriesFromMessage
// (which collapses every zero-write case to an empty array, the right contract
// for its own caller), a tool reporting back to a model needs to say *why*
// nothing new was written — "already saved" is a success, not a failure, and
// telling a model otherwise is telling it something untrue.

test("a new fact is saved and returned", () => {
  resetAssistMemory();
  const outcome = recordSingleMemory("single1", "the server room door code is 4471");

  assert.equal(outcome.status, "saved");
  if (outcome.status !== "saved") return;
  assert.match(outcome.memory.body, /4471/);
  assert.equal(listSessionMemories("single1").length, 1);
});

test("saving the same fact twice reports duplicate, not saved twice", () => {
  resetAssistMemory();
  recordSingleMemory("single2", "the server room door code is 4471");
  const second = recordSingleMemory("single2", "the server room door code is 4471");

  assert.equal(second.status, "duplicate");
  // Exactly one copy exists — the second call did not create a sibling entry.
  assert.equal(listSessionMemories("single2").length, 1);
});

test("the same fact in different sessions is not a duplicate of itself", () => {
  // Duplicate detection is per session; one user's saved fact must not block
  // another session from saving the same words.
  resetAssistMemory();
  recordSingleMemory("single4a", "the server room door code is 4471");
  const otherSession = recordSingleMemory("single4b", "the server room door code is 4471");

  assert.equal(otherSession.status, "saved");
});

test("a fact saved through recordSingleMemory survives a restart", () => {
  resetAssistMemory();
  recordSingleMemory("single5", "the server room door code is 4471");

  reloadAssistMemoryFromDisk();

  const restored = listSessionMemories("single5");
  assert.equal(restored.length, 1);
  assert.match(restored[0].body, /4471/);
});
