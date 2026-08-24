import test from "node:test";
import assert from "node:assert/strict";
import { allPersonalities } from "../src/personalities.js";
import {
  cadenceFor,
  chooseVoice,
  maxSpokenCharacters,
  onlyRemoteVoicesAvailable,
  speakableFrom,
  speechAvailability,
  speechRecognitionIsLocal,
  voiceSettingsFor
} from "../src/speech.js";

/** Enough of a SpeechSynthesisVoice for the selection logic. */
function voice(name: string, lang: string, localService: boolean): SpeechSynthesisVoice {
  return { name, lang, localService, default: false, voiceURI: name } as SpeechSynthesisVoice;
}

test("a machine with no speech synthesis is reported as unable, with a reason", () => {
  const result = speechAvailability(undefined);

  assert.equal(result.available, false);
  if (result.available) return;
  assert.match(result.reason, /no speech synthesis/i);
});

test("a synthesizer with no voices installed cannot speak", () => {
  // The interface must not offer a button that silently does nothing, so an
  // empty voice list is unavailable rather than available-but-mute.
  const result = speechAvailability({ getVoices: () => [] } as unknown as SpeechSynthesis);

  assert.equal(result.available, false);
  if (result.available) return;
  assert.match(result.reason, /no voices/i);
});

test("a local voice is preferred over a remote one", () => {
  // A remote voice sends the text off this machine to be spoken, including
  // anything quoted from the user's own notes.
  const chosen = chooseVoice([
    voice("Cloud Voice", "en-US", false),
    voice("Local Voice", "en-US", true)
  ]);

  assert.equal(chosen?.name, "Local Voice");
});

test("a remote voice is used only when there is no local one", () => {
  const chosen = chooseVoice([voice("Cloud Voice", "en-US", false)]);

  assert.equal(chosen?.name, "Cloud Voice");
  assert.equal(onlyRemoteVoicesAvailable([voice("Cloud Voice", "en-US", false)]), true);
  assert.equal(onlyRemoteVoicesAvailable([voice("Local", "en-US", true)]), false);
});

test("no voices at all yields no choice rather than a crash", () => {
  assert.equal(chooseVoice([]), null);
  assert.equal(onlyRemoteVoicesAvailable([]), false);
});

test("code, links and markup are not read aloud character by character", () => {
  const spoken = speakableFrom(
    "Here is the fix:\n\n```ts\nconst x = 1;\n```\n\nSee https://example.com/a/very/long/path for **more**."
  );

  assert.match(spoken, /code is on screen/);
  assert.doesNotMatch(spoken, /const x/);
  assert.doesNotMatch(spoken, /example\.com/);
  assert.match(spoken, /a link on screen/);
  // The emphasis markers go; the word stays.
  assert.match(spoken, /more/);
  assert.doesNotMatch(spoken, /\*\*/);
});

test("an outcome is never trimmed out of what gets spoken", () => {
  // The sentences this app appends to report what actually happened are the
  // honest part of a reply. Voice being concise must never mean voice being
  // reassuring.
  const spoken = speakableFrom(
    "I have forgotten what you told me.\n\nNothing saved matches \"the codename\", so nothing was deleted."
  );

  assert.match(spoken, /nothing was deleted/);
});

test("a long reply stops at a sentence and says there is more", () => {
  const long = `${"This is a complete sentence. ".repeat(60)}`;
  const spoken = speakableFrom(long);

  assert.ok(spoken.length <= maxSpokenCharacters + 40, `too long: ${spoken.length}`);
  assert.match(spoken, /The rest is on screen\.$/);
  // Cut at a sentence boundary rather than mid-word.
  assert.doesNotMatch(spoken, /\bThi\b|\bsentenc\b/);
});

test("a short reply is spoken whole, with nothing appended", () => {
  const spoken = speakableFrom("144 divided by 12 is 12.");

  assert.equal(spoken, "144 divided by 12 is 12.");
  assert.doesNotMatch(spoken, /on screen/);
});

test("empty and non-string input produce nothing to say", () => {
  assert.equal(speakableFrom(""), "");
  assert.equal(speakableFrom("   "), "");
  assert.equal(speakableFrom(undefined as unknown as string), "");
  assert.equal(speakableFrom(42 as unknown as string), "");
});

test("each personality speaks with its own profile", () => {
  // These profiles have existed since personalities were added and nothing
  // ever read them. This is what reads them.
  const professional = voiceSettingsFor("professional");
  const gaming = voiceSettingsFor("gaming");
  const medical = voiceSettingsFor("medical");

  assert.notDeepEqual(professional, gaming, "profiles that differ must sound different");
  // Gaming is brisk, medical is deliberate — the ordering is the point.
  assert.ok(gaming.rate > medical.rate, "a brisk voice should not be slower than a deliberate one");
});

test("voice settings stay inside what the speech API accepts", () => {
  // Outside 0.1..10 rate and 0..2 pitch the API misbehaves silently, so a
  // future profile cannot break speech by being ambitious.
  for (const id of ["professional", "developer", "creative", "business", "research",
    "teacher", "cyber-security", "gaming", "medical", "legal"] as const) {
    const { rate, pitch } = voiceSettingsFor(id);

    assert.ok(rate >= 0.5 && rate <= 2, `${id} rate out of range: ${rate}`);
    assert.ok(pitch >= 0 && pitch <= 2, `${id} pitch out of range: ${pitch}`);
  }
});

test("an unknown personality falls back rather than throwing", () => {
  const settings = voiceSettingsFor("nonsense" as never);
  assert.ok(settings.rate > 0);
});

test("a personality's cadence is read, not just stored", () => {
  // Every personality has carried a cadence since personalities were added and
  // nothing read it. The neural voice acts on it, so it has to come back
  // faithfully rather than as one value for everyone.
  const cadences = new Set(allPersonalities().map((profile) => cadenceFor(profile.id as never)));
  assert.ok(cadences.size > 1, "every personality resolved to the same cadence");
});

test("an unknown personality still yields a usable cadence", () => {
  assert.ok(["measured", "brisk", "playful", "deliberate"].includes(cadenceFor("nonsense" as never)));
});

test("speech recognition is recorded as not local, and is not implemented", () => {
  // The decision, kept in the code rather than only in a commit message: the
  // browser's recognition streams audio to a remote service, and this app
  // tells the user nothing is uploaded.
  assert.equal(speechRecognitionIsLocal, false);
});
