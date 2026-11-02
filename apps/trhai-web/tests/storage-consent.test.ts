import test from "node:test";
import assert from "node:assert/strict";
import { legalDocument, legalFacts } from "@ascend/shared";
import {
  MemoryStorage, clearOptionalStorage, essentialStorageKeys, optionalStorageAllowed, optionalStorageKeys, readStorageConsent,
  storageConsentKey, writeStorageConsent
} from "../src/lib/storageConsent.js";

// What may be kept in the window's storage, and the one list that says so.

test("nothing optional is kept until the person says yes, and a no removes what a yes had kept", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  assert.equal(readStorageConsent(local), null);
  assert.equal(optionalStorageAllowed(local), false, "no answer is not a yes");

  const yes = writeStorageConsent(local, session, "all", "2026-11-01", new Date("2026-11-02T10:00:00Z"));
  assert.deepEqual(yes, { decision: "all", version: "2026-11-01", at: "2026-11-02T10:00:00.000Z" });
  assert.deepEqual(readStorageConsent(local), yes);
  assert.equal(optionalStorageAllowed(local), true);

  local.setItem("trhai.accent.v1", "violet");
  local.setItem("trhai.auth.v1", "keep-me");
  session.setItem("trhai.os.slim.v1", "1");
  writeStorageConsent(local, session, "essential", "2026-11-01");
  assert.equal(optionalStorageAllowed(local), false);
  assert.equal(local.getItem("trhai.accent.v1"), null, "the remembered colour is gone");
  assert.equal(session.getItem("trhai.os.slim.v1"), null);
  assert.equal(local.getItem("trhai.auth.v1"), "keep-me", "the sign-in is not a remembered choice");
  assert.equal(readStorageConsent(local)?.decision, "essential", "the answer itself is kept");
});

test("a broken or foreign answer reads as no answer", () => {
  const local = new MemoryStorage();
  local.setItem(storageConsentKey, "{not json");
  assert.equal(readStorageConsent(local), null);
  local.setItem(storageConsentKey, JSON.stringify({ decision: "maybe", version: "x", at: "y" }));
  assert.equal(readStorageConsent(local), null);
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  assert.equal(readStorageConsent(throwing), null);
  assert.doesNotThrow(() => writeStorageConsent(throwing, throwing, "all", "v"));
  assert.doesNotThrow(() => clearOptionalStorage(throwing, undefined));
});

test("every key the app uses is on exactly one of the two lists, and the storage text names each one", () => {
  const essential = [...essentialStorageKeys];
  const optional = [...optionalStorageKeys];
  assert.equal(new Set([...essential, ...optional]).size, essential.length + optional.length, "no key on both lists");
  const text = JSON.stringify(legalDocument("storage", legalFacts));
  for (const key of [...essential, ...optional]) assert.ok(text.includes(`\`${key}\``), `the storage text names ${key}`);
  // And the text names nothing the app does not use.
  for (const named of text.matchAll(/`(trhai\.[a-z0-9.-]+)`/g)) {
    assert.ok(essential.includes(named[1] as never) || optional.includes(named[1] as never), `${named[1]} is in the text but on neither list`);
  }
});

test("a memory store behaves as a Storage", () => {
  const store = new MemoryStorage();
  assert.equal(store.length, 0);
  store.setItem("a", "1");
  store.setItem("b", "2");
  assert.equal(store.length, 2);
  assert.equal(store.getItem("a"), "1");
  assert.equal(store.key(1), "b");
  assert.equal(store.key(5), null);
  store.removeItem("a");
  assert.equal(store.getItem("a"), null);
  store.clear();
  assert.equal(store.length, 0);
});
