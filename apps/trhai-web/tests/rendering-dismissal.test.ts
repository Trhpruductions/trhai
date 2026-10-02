import test from "node:test";
import assert from "node:assert/strict";
import { readDismissedRendering, renderingKey, writeDismissedRendering } from "../src/lib/renderingDismissal.js";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  };
}

const settings = { name: "settings", createdAt: "2026-09-20T18:37:08.677Z" };

test("a dismissal survives a reload", () => {
  // Live: an eleven-day-old "Settings" mockup came back over the core on every
  // launch, however many times it had been closed.
  const storage = memoryStorage();
  writeDismissedRendering(storage, renderingKey(settings));
  assert.equal(readDismissedRendering(storage), renderingKey(settings));
});

test("a new rendering under a name used before is not covered by the old dismissal", () => {
  const again = { name: "settings", createdAt: "2026-10-02T09:00:00.000Z" };
  assert.notEqual(renderingKey(again), renderingKey(settings));
});

test("nothing dismissed, missing storage and hostile storage are all handled", () => {
  assert.equal(readDismissedRendering(memoryStorage()), null);
  assert.equal(readDismissedRendering(undefined), null);
  const hostile = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); }
  };
  assert.equal(readDismissedRendering(hostile), null);
  assert.doesNotThrow(() => writeDismissedRendering(hostile, renderingKey(settings)));
});
