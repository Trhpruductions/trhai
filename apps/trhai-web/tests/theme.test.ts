import test from "node:test";
import assert from "node:assert/strict";
import { accents, defaultAccent, isAccent, readStoredAccent, themeBootScript, writeStoredAccent } from "../src/lib/theme.js";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  };
}

test("every real accent is recognised", () => {
  for (const accent of accents) assert.equal(isAccent(accent), true);
});

test("anything not on the list is rejected, not guessed at", () => {
  assert.equal(isAccent("teal"), false);
  assert.equal(isAccent(""), false);
  assert.equal(isAccent(undefined), false);
  assert.equal(isAccent(42), false);
});

test("no stored value falls back to the default", () => {
  assert.equal(readStoredAccent(memoryStorage()), defaultAccent);
});

test("a stored choice round-trips", () => {
  const storage = memoryStorage();
  writeStoredAccent(storage, "violet");
  assert.equal(readStoredAccent(storage), "violet");
});

test("a corrupted stored value falls back rather than applying garbage", () => {
  const storage = memoryStorage();
  storage.setItem("trhai.accent.v1", "not-a-real-accent");
  assert.equal(readStoredAccent(storage), defaultAccent);
});

test("a hostile storage never throws", () => {
  const hostile = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); }
  };
  assert.doesNotThrow(() => readStoredAccent(hostile));
  assert.doesNotThrow(() => writeStoredAccent(hostile, "amber"));
});

test("missing storage (no window) is handled, not a crash", () => {
  assert.equal(readStoredAccent(undefined), defaultAccent);
  assert.doesNotThrow(() => writeStoredAccent(undefined, "cyan"));
});

test("the boot script only ever writes one of the real accent values", () => {
  const script = themeBootScript();
  for (const accent of accents) assert.match(script, new RegExp(accent));
  // No accent name should be constructed from anything but this fixed list —
  // the script has to end up unable to set an attribute value that isn't one
  // of these, which the valid.indexOf check enforces.
  assert.match(script, /valid\.indexOf\(a\)!==-1/);
});
