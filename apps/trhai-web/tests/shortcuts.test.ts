import test from "node:test";
import assert from "node:assert/strict";
import { setSingleKeyShortcut, singleKeyShortcutKey, singleKeyShortcutOn } from "../src/lib/shortcuts";
import { MemoryStorage, essentialStorageKeys } from "../src/lib/storageConsent";

// The switch for the one single-key shortcut ("/" to the command bar).

test("the single-key shortcut is on until it is turned off, and nothing is stored while it is on", () => {
  const store = new MemoryStorage();
  assert.equal(singleKeyShortcutOn(store), true);
  setSingleKeyShortcut(false, store);
  assert.equal(store.getItem(singleKeyShortcutKey), "off");
  assert.equal(singleKeyShortcutOn(store), false);
  setSingleKeyShortcut(true, store);
  assert.equal(store.getItem(singleKeyShortcutKey), null);
  assert.equal(singleKeyShortcutOn(store), true);
  assert.equal(singleKeyShortcutOn(undefined), true, "no storage at all: on");
});

test("the switch is kept with the settings the app needs, so it holds whatever was answered about remembered choices", () => {
  assert.ok((essentialStorageKeys as readonly string[]).includes(singleKeyShortcutKey));
});

test("a storage that refuses still lets the switch work for this page", () => {
  const refusing = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); }
  };
  setSingleKeyShortcut(false, refusing);
  assert.equal(singleKeyShortcutOn(refusing), false);
  setSingleKeyShortcut(true, refusing);
  assert.equal(singleKeyShortcutOn(refusing), true);
});
