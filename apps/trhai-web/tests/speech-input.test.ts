import test from "node:test";
import assert from "node:assert/strict";
import { whyNotListen } from "../src/lib/speechInput.js";

test("the microphone records only when something can turn speech into words", () => {
  assert.equal(whyNotListen({ available: true, reason: null }), null);
  // Still being checked: the press goes through, and Stop says if it could not be transcribed.
  assert.equal(whyNotListen({ available: null, reason: null }), null);
  assert.match(whyNotListen({ available: false, reason: null }) ?? "", /speech-to-text is not installed/);
  assert.equal(whyNotListen({ available: false, reason: "whisper.cpp was not found." }), "whisper.cpp was not found.");
});
