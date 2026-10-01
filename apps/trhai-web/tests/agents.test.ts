import test from "node:test";
import assert from "node:assert/strict";
import { chooseAgent, marketplaceStorageKey, readActiveAgent } from "../src/lib/agents.js";

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  } as unknown as Storage;
}

test("no agent is active until one is chosen", () => {
  assert.equal(readActiveAgent(memoryStorage()), null);
  assert.equal(readActiveAgent(undefined), null);
});

test("choosing an agent makes it active, with nothing to install first", () => {
  // The marketplace page that installed agents is gone; choosing one here has
  // to be the whole act, or the picker would select nothing.
  const storage = memoryStorage();
  const chosen = chooseAgent(storage, "programmer");
  assert.equal(chosen?.name, "Ada");
  assert.equal(readActiveAgent(storage)?.id, "programmer", "and it is still active on the next read");
});

test("switching agents, and clearing back to none, both stick", () => {
  const storage = memoryStorage();
  chooseAgent(storage, "programmer");
  assert.equal(chooseAgent(storage, "researcher")?.name, "Quill");
  assert.equal(readActiveAgent(storage)?.id, "researcher");
  assert.equal(chooseAgent(storage, null), null);
  assert.equal(readActiveAgent(storage), null);
});

test("an id the catalogue does not know changes nothing", () => {
  const storage = memoryStorage();
  chooseAgent(storage, "designer");
  assert.equal(chooseAgent(storage, "not-an-agent")?.id, "designer");
});

test("a stored state from the old marketplace page is read the same way", () => {
  // Same key, same shape: an agent activated in an earlier build stays active.
  const storage = memoryStorage();
  storage.setItem(marketplaceStorageKey, JSON.stringify({ installed: ["lawyer"], activeAgentId: "lawyer" }));
  assert.equal(readActiveAgent(storage)?.name, "Sterling");
});

test("a hostile storage never throws", () => {
  const hostile = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); }
  } as unknown as Storage;
  assert.doesNotThrow(() => readActiveAgent(hostile));
  assert.doesNotThrow(() => chooseAgent(hostile, "programmer"));
});
