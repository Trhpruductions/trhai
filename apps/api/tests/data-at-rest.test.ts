import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Stores written before encryption existed, and not saved since, are rewritten
// encrypted at startup: holding exactly what they held, with backups and
// anything unreadable left as they were.

const { encryptPlainStores, looksEncrypted } = await import("../src/services/dataInventory.js");
const { readProtectedJsonFile, writeProtectedJsonFile } = await import("../src/services/protectedJson.js");

const folders: string[] = [];
function folder(): string {
  const created = mkdtempSync(path.join(tmpdir(), "ascend-at-rest-"));
  folders.push(created);
  return created;
}

test.after(() => {
  for (const created of folders) rmSync(created, { recursive: true, force: true });
});

test("a store kept as plain JSON is rewritten encrypted, holding exactly what it held", () => {
  const directory = folder();
  const accounts = {
    version: 1,
    accounts: [{ id: "a1", email: "owner@example.com", salt: "5a17", hash: "ab12" }],
    tokens: [{ token: "an old plain session", userId: "a1", expiresAt: "2026-09-05T00:00:00.000Z" }]
  };
  writeFileSync(path.join(directory, "accounts.json"), JSON.stringify(accounts, null, 2));
  writeFileSync(path.join(directory, "preferences.json"), JSON.stringify({ voice: "en_US-amy" }));

  const outcome = encryptPlainStores(directory);

  assert.deepEqual(outcome, { encrypted: ["accounts.json", "preferences.json"], failed: [] });
  for (const name of ["accounts.json", "preferences.json"]) assert.equal(looksEncrypted(path.join(directory, name)), true, name);
  assert.deepEqual(readProtectedJsonFile(path.join(directory, "accounts.json")), accounts);
  assert.deepEqual(readProtectedJsonFile(path.join(directory, "preferences.json")), { voice: "en_US-amy" });
  assert.doesNotMatch(readFileSync(path.join(directory, "accounts.json"), "utf8"), /owner@example\.com|an old plain session/,
    "nothing in it can be read off the disk");
  assert.deepEqual(readdirSync(directory).sort(), ["accounts.json", "preferences.json"], "no temporary file is left behind");
});

test("encrypted stores, backups and anything that is not a readable store are left exactly as they were", () => {
  const directory = folder();
  writeProtectedJsonFile(path.join(directory, "conversations.json"), { turns: ["already encrypted"] });
  writeFileSync(path.join(directory, "conversations.backup.json"), JSON.stringify({ turns: ["a plain backup"] }));
  writeFileSync(path.join(directory, "notes.txt"), "not a store");
  writeFileSync(path.join(directory, "broken.json"), "{ not json");
  const before = new Map(readdirSync(directory).map((name) => [name, readFileSync(path.join(directory, name), "utf8")]));

  const outcome = encryptPlainStores(directory);

  assert.deepEqual(outcome.encrypted, []);
  assert.deepEqual(outcome.failed.map((entry) => entry.name), ["broken.json"], "a file that cannot be read is reported, not replaced");
  for (const [name, text] of before) assert.equal(readFileSync(path.join(directory, name), "utf8"), text, `${name} is untouched`);
  assert.deepEqual(readdirSync(directory).sort(), [...before.keys()].sort(), "no temporary file is left behind");
});

test("running it again changes nothing", () => {
  const directory = folder();
  writeFileSync(path.join(directory, "command-arm.json"), JSON.stringify({ armedUntil: null }));
  assert.deepEqual(encryptPlainStores(directory).encrypted, ["command-arm.json"]);
  const first = readFileSync(path.join(directory, "command-arm.json"), "utf8");

  assert.deepEqual(encryptPlainStores(directory), { encrypted: [], failed: [] });
  assert.equal(readFileSync(path.join(directory, "command-arm.json"), "utf8"), first, "an encrypted store is not rewritten");
  assert.deepEqual(readProtectedJsonFile(path.join(directory, "command-arm.json")), { armedUntil: null });
});

test("a data folder that does not exist yet is nothing to do", () => {
  assert.deepEqual(encryptPlainStores(path.join(tmpdir(), `ascend-at-rest-missing-${process.pid}-${Date.now()}`)), { encrypted: [], failed: [] });
});
