import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultPreferences,
  parsePreferences,
  readPreferences,
  resetPreferences,
  setPreferencesPersistence,
  updatePreferences
} from "../src/services/preferences.js";

setPreferencesPersistence(false);

test("preferences start at a sensible default", () => {
  resetPreferences();
  assert.equal(readPreferences().personality, defaultPreferences.personality);
});

test("an update is readable straight back", () => {
  resetPreferences();
  const next = updatePreferences({ personality: "developer" });

  assert.equal(next.personality, "developer");
  assert.equal(readPreferences().personality, "developer");
});

test("an update returns the whole state, not just the change", () => {
  // So a caller never has to guess what the resulting state is.
  resetPreferences();
  assert.deepEqual(updatePreferences({ personality: "creative" }), { personality: "creative" });
});

test("an empty or missing value leaves the setting alone", () => {
  // A malformed request must not silently reset a preference to the default.
  resetPreferences();
  updatePreferences({ personality: "legal" });

  assert.equal(updatePreferences({}).personality, "legal");
  assert.equal(updatePreferences({ personality: "   " }).personality, "legal");
  assert.equal(updatePreferences({ personality: undefined }).personality, "legal");
});

test("a corrupt stored file falls back rather than breaking the app", () => {
  // The file outlives the code that wrote it and can be hand-edited.
  assert.deepEqual(parsePreferences(null), defaultPreferences);
  assert.deepEqual(parsePreferences("nonsense"), defaultPreferences);
  assert.deepEqual(parsePreferences({ personality: 42 }), defaultPreferences);
  assert.deepEqual(parsePreferences({}), defaultPreferences);
});

test("a stored personality survives parsing", () => {
  assert.equal(parsePreferences({ personality: "research" }).personality, "research");
  assert.equal(parsePreferences({ personality: "  research  " }).personality, "research");
});
