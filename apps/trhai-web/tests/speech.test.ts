import test from "node:test";
import assert from "node:assert/strict";
import { maxSpokenCharacters, speakableFrom } from "../src/lib/speech.js";

test("code, links and markup are not read aloud character by character", () => {
  const text = "See `npm test` and **this** at https://example.com/x, plus a ```block```.";
  const spoken = speakableFrom(text);

  assert.doesNotMatch(spoken, /```/);
  assert.doesNotMatch(spoken, /https?:\/\//);
  assert.match(spoken, /npm test/);
  assert.match(spoken, /this/);
});

test("a short reply is spoken whole, with nothing appended", () => {
  const spoken = speakableFrom("Done.");
  assert.equal(spoken, "Done.");
});

test("a long reply stops at a sentence and says there is more", () => {
  const sentence = "This is one sentence that repeats itself over and over. ";
  const long = sentence.repeat(40);
  const spoken = speakableFrom(long);

  assert.ok(spoken.length < long.length);
  assert.match(spoken, /The rest is on screen\.$/);
});

test("empty and non-string input produce nothing to say", () => {
  assert.equal(speakableFrom(""), "");
  assert.equal(speakableFrom(undefined as unknown as string), "");
});

test("the length limit is a real constant, not a guess", () => {
  assert.equal(maxSpokenCharacters, 700);
});
