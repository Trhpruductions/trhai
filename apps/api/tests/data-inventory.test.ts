import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

// Settings > Data & privacy: every store TRH AI keeps, what it holds, and
// whether it is really encrypted - read from the file, not assumed.

const dataDir = mkdtempSync(path.join(tmpdir(), "ascend-data-inventory-"));
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations-route.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts-route.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { createApp } = await import("../src/server.js");
const { dataInventory, looksEncrypted } = await import("../src/services/dataInventory.js");
const { dataRoot } = await import("../src/services/dataDirectory.js");
const { writeProtectedJsonFile } = await import("../src/services/protectedJson.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("each store is listed with what it holds and whether it is really encrypted", () => {
  const root = dataRoot();
  mkdirSync(root, { recursive: true });
  writeProtectedJsonFile(path.join(root, "conversations.json"), { secret: "kept encrypted" });
  writeFileSync(path.join(root, "conversations.backup.json"), JSON.stringify({ turns: ["kept in plain text"] }));
  writeFileSync(path.join(root, "conversations.json.tmp"), "mid-write");
  mkdirSync(path.join(root, "a-folder"), { recursive: true });

  const inventory = dataInventory();
  const conversations = inventory.files.find((file) => file.name === "conversations.json");
  const backup = inventory.files.find((file) => file.name === "conversations.backup.json");
  assert.equal(conversations?.encrypted, true);
  assert.equal(conversations?.about, "Your conversations");
  assert.equal(backup?.encrypted, false, "a plain copy is reported as plain");
  assert.match(backup?.about ?? "", /backup/i);
  assert.ok(!inventory.files.some((file) => file.name.endsWith(".tmp") || file.name === "a-folder"), "neither a half-written file nor a folder is a store");
  assert.equal(inventory.directory, root);
  assert.match(inventory.keyFile, /key/);
});

test("encryption is read from the file's own first bytes", () => {
  const root = dataRoot();
  writeProtectedJsonFile(path.join(root, "probe.json"), { a: 1 });
  writeFileSync(path.join(root, "plain.json"), JSON.stringify({ protected: false, a: 1 }));
  assert.equal(looksEncrypted(path.join(root, "probe.json")), true);
  assert.equal(looksEncrypted(path.join(root, "plain.json")), false);
  assert.equal(looksEncrypted(path.join(root, "missing.json")), false);
});

test("GET /v1/system/data lists names, sizes and dates - and nothing from inside a store", async () => {
  const server = createApp().listen(0);
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/system/data`);
    const body = await response.text();
    assert.equal(response.status, 200);
    const { data } = JSON.parse(body) as { data: { files: Array<{ name: string; bytes: number; encrypted: boolean }> } };
    assert.ok(data.files.some((file) => file.name === "conversations.json"));
    assert.doesNotMatch(body, /kept encrypted|kept in plain text/, "a store's contents never leave it");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
