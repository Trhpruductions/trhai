import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiredChannels, requiredSampleRate } from "../src/services/whisperTranscribe.js";

// The browser's encoder and whisper have to agree, and nothing made them.
//
// The rate is written down twice, in two workspaces that share no code:
// `targetSampleRate` in apps/trhai-web/src/lib/wav.ts, which is what the
// microphone resamples to before POSTing, and `requiredSampleRate` here, which
// is what the transcriber refuses anything else for. Change either one and
// voice input stops working, with no failing test and no error that names the
// cause - the client sends, the server says "Audio must be 16 kHz mono", and
// the microphone appears to be broken.
//
// Verified by hand once: Piper's own speech, put through the real
// resampleMono/encodeWav from the web app, came back from whisper as "Testing
// 1, 2, 3." That proves they agree today. This is what keeps them agreeing.
//
// Read off disk rather than imported, because trhai-web is not a dependency of
// this workspace and should not become one for a number. Same approach as the
// dev-port agreement test, and for the same reason.

const here = path.dirname(fileURLToPath(import.meta.url));
const webWav = path.join(here, "..", "..", "trhai-web", "src", "lib", "wav.ts");

function constantIn(source: string, name: string): number {
  // Found by scanning rather than by a constructed RegExp: `\s` inside a
  // template literal is an escape JS resolves to a bare "s", so the pattern
  // silently stopped matching and the test failed claiming the constant had
  // been renamed when it had not.
  const line = source
    .split(/\r?\n/)
    .find((candidate) => candidate.includes(`export const ${name}`));

  assert.ok(line, `${name} is not declared in ${webWav} - if it was renamed, this test must follow`);
  const digits = /=\s*([0-9_]+)/.exec(line);
  assert.ok(digits, `${name} is declared but not as a plain number: ${line}`);
  return Number(digits[1].replace(/_/g, ""));
}

test("the browser encodes at the rate whisper demands", () => {
  const source = readFileSync(webWav, "utf8");
  assert.equal(
    constantIn(source, "targetSampleRate"),
    requiredSampleRate,
    "the microphone would send audio the transcriber refuses"
  );
});

test("and in mono, which is the other half of the requirement", () => {
  // encodeWav writes a fixed channel count; if that ever becomes a variable
  // this test should be taught to read it rather than deleted.
  const source = readFileSync(webWav, "utf8");
  assert.match(source, /channels\s*=\s*1|setUint16\(22,\s*1/, "the encoder no longer writes mono");
  assert.equal(requiredChannels, 1);
});
