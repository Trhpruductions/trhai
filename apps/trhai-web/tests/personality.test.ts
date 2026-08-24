import test from "node:test";
import assert from "node:assert/strict";
import { defaultPersonality } from "@ascend/shared";
import { readStoredPersonality, writeStoredPersonality } from "../src/lib/personality.js";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  };
}

test("no stored value falls back to the default personality", () => {
  assert.equal(readStoredPersonality(memoryStorage()), defaultPersonality);
});

test("a stored choice round-trips", () => {
  const storage = memoryStorage();
  writeStoredPersonality(storage, "developer");
  assert.equal(readStoredPersonality(storage), "developer");
});

test("a corrupted stored value falls back rather than applying garbage", () => {
  const storage = memoryStorage();
  storage.setItem("trhai.personality.v1", "not-a-real-personality");
  assert.equal(readStoredPersonality(storage), defaultPersonality);
});

test("a hostile storage never throws", () => {
  const hostile = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); }
  };
  assert.doesNotThrow(() => readStoredPersonality(hostile));
  assert.doesNotThrow(() => writeStoredPersonality(hostile, "creative"));
});

test("missing storage (no window) is handled, not a crash", () => {
  assert.equal(readStoredPersonality(undefined), defaultPersonality);
  assert.doesNotThrow(() => writeStoredPersonality(undefined, "business"));
});
