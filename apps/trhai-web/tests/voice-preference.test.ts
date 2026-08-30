import test from "node:test";
import assert from "node:assert/strict";
import {
  clampRate, defaultVoice, readStoredVoice, writeStoredVoice
} from "../src/lib/voicePreference.js";

// The voice was a constant chosen by reasoning about accents. It is a stored
// choice now, and these are the cases where a stored value must not be trusted
// straight through to the synthesiser.

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    read: () => map
  };
}

test("with nothing stored, the default British male voice is used", () => {
  const choice = readStoredVoice(fakeStorage());
  assert.equal(choice.voiceId, "en_GB-alan-medium");
  assert.equal(choice.cadence, "measured");
});

test("a stored choice round-trips", () => {
  const storage = fakeStorage();
  writeStoredVoice(storage, { voiceId: "en_GB-cori-high", rate: 1.1, cadence: "brisk" });
  const read = readStoredVoice(storage);
  assert.equal(read.voiceId, "en_GB-cori-high");
  assert.equal(read.rate, 1.1);
  assert.equal(read.cadence, "brisk");
});

test("an unrecognised voice id is kept, not overwritten", () => {
  // The installed set differs per machine and the service substitutes and
  // reports what actually spoke. Refusing an id this build has never heard of
  // would strand anyone who installed a new voice.
  const storage = fakeStorage({ "trhai.voice.v1": '{"voiceId":"en_GB-something-new","rate":1,"cadence":"measured"}' });
  assert.equal(readStoredVoice(storage).voiceId, "en_GB-something-new");
});

test("a nonsense cadence falls back rather than reaching the synthesiser", () => {
  const storage = fakeStorage({ "trhai.voice.v1": '{"voiceId":"x","rate":1,"cadence":"shouty"}' });
  assert.equal(readStoredVoice(storage).cadence, "measured");
});

test("the rate is clamped to the range the synthesiser behaves in", () => {
  // Outside roughly 0.7-1.4 Piper distorts, and a slider that can produce a
  // voice nobody can understand is not a setting, it is a trap.
  assert.equal(clampRate(9), 1.4);
  assert.equal(clampRate(0.01), 0.7);
  assert.equal(clampRate(1.05), 1.05);
});

test("a rate that is not a number falls back to the default", () => {
  assert.equal(clampRate("fast"), defaultVoice.rate);
  assert.equal(clampRate(Number.NaN), defaultVoice.rate);
  assert.equal(clampRate(undefined), defaultVoice.rate);
});

test("corrupt stored JSON does not break speech", () => {
  const storage = fakeStorage({ "trhai.voice.v1": "{not json" });
  assert.deepEqual(readStoredVoice(storage), defaultVoice);
});

test("missing storage is survivable", () => {
  assert.deepEqual(readStoredVoice(undefined), defaultVoice);
  assert.doesNotThrow(() => writeStoredVoice(undefined, defaultVoice));
});
