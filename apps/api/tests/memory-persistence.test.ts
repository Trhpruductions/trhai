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
