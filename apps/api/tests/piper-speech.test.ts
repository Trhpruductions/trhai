import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const {
  deliveryFor,
  describeVoiceFile,
  expressionScale,
  installedVoices,
  lengthScaleFor,
  maxSynthesisCharacters,
  piperRoot,
  piperStatus,
  synthesize
} = await import("../src/services/piperSpeech.js");

// Local neural speech.
//
// These tests must pass on a machine that has never installed Piper, because
// most will not have it — so what is verified here is that the *absence* is
// reported accurately rather than crashing or, worse, silently returning
// nothing while claiming success. The one test that actually synthesizes skips
// itself when there is no install to synthesize with.

/** A directory shaped like an install, with fake files of the right names. */
function fakeInstall(options: { binary?: boolean; models?: string[] } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "piper-fake-"));
  if (options.binary) {
    writeFileSync(path.join(dir, process.platform === "win32" ? "piper.exe" : "piper"), "not a real binary");
  }

  for (const model of options.models ?? []) {
    writeFileSync(path.join(dir, `${model}.onnx`), "not a real model");
    writeFileSync(path.join(dir, `${model}.onnx.json`), "{}");
  }

  return dir;
}

/** Point the module at `dir` for one test, then put the environment back. */
async function withInstall(dir: string | null, body: () => Promise<void> | void) {
  const previousDir = process.env.VEXORA_PIPER_DIR;
  const previousVoice = process.env.VEXORA_PIPER_VOICE;

  process.env.VEXORA_PIPER_DIR = dir ?? path.join(tmpdir(), "piper-definitely-not-here");
  delete process.env.VEXORA_PIPER_VOICE;

  try {
    await body();
  } finally {
    if (previousDir === undefined) delete process.env.VEXORA_PIPER_DIR;
    else process.env.VEXORA_PIPER_DIR = previousDir;
    if (previousVoice === undefined) delete process.env.VEXORA_PIPER_VOICE;
    else process.env.VEXORA_PIPER_VOICE = previousVoice;
  }
}

// ---- Reading voices off disk ---------------------------------------------

test("a model filename becomes a named voice", () => {
  const voice = describeVoiceFile("en_GB-alan-medium.onnx");

  assert.equal(voice?.id, "en_GB-alan-medium");
  assert.equal(voice?.name, "Alan");
  assert.equal(voice?.locale, "en_GB");
  assert.equal(voice?.quality, "medium");
});

test("a speaker name with underscores reads as words", () => {
  // "northern_english_male" is a filename, not something to show a person.
  assert.equal(describeVoiceFile("en_GB-northern_english_male-medium.onnx")?.name, "Northern English Male");
});

test("files that are not voice models are ignored rather than guessed at", () => {
  for (const name of ["onnxruntime.dll", "piper.exe", "notes.txt", "en_US-amy.onnx", "-.onnx"]) {
    assert.equal(describeVoiceFile(name), null, name);
  }
});

test("voices are listed best quality first", async () => {
  const dir = fakeInstall({
    binary: true,
    models: ["en_US-amy-medium", "en_US-ryan-high", "en_US-kyle-low"]
  });

  await withInstall(dir, () => {
    assert.deepEqual(installedVoices().map((voice) => voice.id), [
      "en_US-ryan-high",
      "en_US-amy-medium",
      "en_US-kyle-low"
    ]);
  });
});

test("among equal quality, the assistant's own register comes first", async () => {
  const dir = fakeInstall({ binary: true, models: ["en_US-ryan-high", "en_GB-cori-high"] });

  await withInstall(dir, () => {
    assert.equal(installedVoices()[0]?.id, "en_GB-cori-high");
  });
});

test("a model missing its companion JSON is not offered", async () => {
  const dir = fakeInstall({ binary: true, models: ["en_GB-cori-high"] });
  // Present, but unloadable — piper needs the JSON for the sample rate.
  writeFileSync(path.join(dir, "en_US-broken-high.onnx"), "no companion");

  await withInstall(dir, () => {
    // Listing it would put a voice in the picker that produces nothing.
    assert.deepEqual(installedVoices().map((voice) => voice.id), ["en_GB-cori-high"]);
  });
});

// ---- Reporting what is installed -----------------------------------------

test("reports plainly when Piper is not installed", async () => {
  await withInstall(null, () => {
    const status = piperStatus();
    assert.equal(status.available, false);
    assert.match(status.available === false ? status.reason : "", /not installed/i);
  });
});

test("distinguishes a missing voice model from a missing binary", async () => {
  await withInstall(fakeInstall({ binary: true }), () => {
    const status = piperStatus();
    assert.equal(status.available, false);
    // The difference matters: one is "install the program", the other is
    // "download a voice", and telling the user the wrong one wastes their time.
    assert.match(status.available === false ? status.reason : "", /no voice model/i);
  });
});

test("reports available with the best voice and the full list", async () => {
  const dir = fakeInstall({ binary: true, models: ["en_US-amy-medium", "en_GB-cori-high"] });

  await withInstall(dir, () => {
    const status = piperStatus();
    assert.equal(status.available, true);
    if (!status.available) return;
    assert.equal(status.voice.id, "en_GB-cori-high");
    assert.equal(status.voices.length, 2);
  });
});

test("a configured voice wins over the ranking", async () => {
  const dir = fakeInstall({ binary: true, models: ["en_US-amy-medium", "en_GB-cori-high"] });

  await withInstall(dir, () => {
    process.env.VEXORA_PIPER_VOICE = "en_US-amy-medium";
    const status = piperStatus();
    assert.equal(status.available === true ? status.voice.id : "", "en_US-amy-medium");
  });
});

test("a configured voice that is not installed does not silently swap", async () => {
  const dir = fakeInstall({ binary: true, models: ["en_GB-cori-high"] });

  await withInstall(dir, () => {
    process.env.VEXORA_PIPER_VOICE = "en_US-nonexistent-high";
    const status = piperStatus();
    // It falls back, but to the ranked default — the point is that it never
    // reports the requested voice as though it had been used.
    assert.equal(status.available === true ? status.voice.id : "", "en_GB-cori-high");
  });
});

// ---- Delivery -------------------------------------------------------------

test("speaking rate becomes an inverse length scale", () => {
  // Length scale is duration, so it runs opposite to rate.
  assert.equal(lengthScaleFor(1), "1.000");
  assert.equal(lengthScaleFor(2), "0.500");
  assert.equal(lengthScaleFor(0.5), "2.000");
});

test("a nonsense rate falls back to the voice's own pace", () => {
  // A bad number must not reach the command line, and must not fail the
  // request either — speaking normally is the right answer to "rate: null".
  for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, "fast" as unknown as number]) {
    assert.equal(lengthScaleFor(bad), "1.000");
  }
});

test("an extreme rate is clamped rather than passed through", () => {
  assert.equal(lengthScaleFor(1000), "0.500");
  assert.equal(lengthScaleFor(-5), "2.000");
  assert.equal(lengthScaleFor(0), "2.000");
});

test("each cadence gets a delivery of its own", () => {
  const playful = deliveryFor("playful");
  const deliberate = deliveryFor("deliberate");

  // A cadence that produced identical settings would mean the personality
  // profiles still were not being read, only more elaborately ignored.
  assert.ok(playful.expression > deliberate.expression);
  assert.ok(playful.sentencePause < deliberate.sentencePause);
});

test("an unknown cadence falls back to the measured delivery", () => {
  assert.deepEqual(deliveryFor(undefined), deliveryFor("measured"));
  assert.deepEqual(deliveryFor("nonsense" as never), deliveryFor("measured"));
});

test("expression is varied enough that speech is not flat", () => {
  // Flat delivery is most of what people mean when they call a synthetic
  // voice robotic, so every cadence has to keep some variation.
  for (const cadence of ["measured", "brisk", "playful", "deliberate"] as const) {
    const { expression, rhythm } = deliveryFor(cadence);
    assert.ok(expression >= 0.5, `${cadence} expression too flat: ${expression}`);
    assert.ok(rhythm >= 0.7, `${cadence} rhythm too even: ${rhythm}`);
  }
});

test("expressiveness scales the cadence without overriding it", () => {
  const base = 0.72;

  // Unset means neutral: the cadence stands exactly as written.
  assert.equal(expressionScale(base, undefined), base.toFixed(3));
  assert.equal(expressionScale(base, 0.5), base.toFixed(3));

  assert.ok(Number(expressionScale(base, 1)) > base);
  assert.ok(Number(expressionScale(base, 0)) < base);
});

test("expression stays inside the range the synthesizer behaves in", () => {
  // Past roughly 1.0 the variation stops sounding like inflection and starts
  // sounding like a fault.
  for (const value of [-100, 0, 0.5, 1, 100, Number.NaN]) {
    const scaled = Number(expressionScale(0.95, value));
    assert.ok(scaled >= 0.1 && scaled <= 1, `out of range: ${scaled}`);
  }
});

// ---- Synthesis ------------------------------------------------------------

test("synthesis refuses rather than throwing when nothing is installed", async () => {
  await withInstall(null, async () => {
    const result = await synthesize("Hello.");
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /not installed/i);
  });
});

test("empty text is refused before anything is spawned", async () => {
  await withInstall(fakeInstall({ binary: true, models: ["en_US-amy-medium"] }), async () => {
    const result = await synthesize("   ");
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /nothing to say/i);
  });
});

test("text past the length limit is refused", async () => {
  await withInstall(fakeInstall({ binary: true, models: ["en_US-amy-medium"] }), async () => {
    const result = await synthesize("a".repeat(maxSynthesisCharacters + 1));
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /too long/i);
  });
});

test("a binary that is not really a binary fails with a reason, not a crash", async () => {
  await withInstall(fakeInstall({ binary: true, models: ["en_US-amy-medium"] }), async () => {
    const result = await synthesize("Hello.");
    // The exact failure differs by platform — spawn may reject the file
    // outright, or start it and have it exit non-zero. Either way it must come
    // back as a reported failure rather than an unhandled throw.
    assert.equal(result.ok, false);
    assert.ok((result.ok === false ? result.reason : "").length > 0);
  });
});

test("the default install location is under the user's own directory", () => {
  const previous = process.env.VEXORA_PIPER_DIR;
  delete process.env.VEXORA_PIPER_DIR;
  try {
    // Not in the repo, and not somewhere needing administrator rights: voice
    // models run to hundreds of megabytes and must never end up committed,
    // and installing must never require elevation.
    assert.match(piperRoot(), /[\\/]Vexora[\\/]piper/);
  } finally {
    if (previous !== undefined) process.env.VEXORA_PIPER_DIR = previous;
  }
});

// Only meaningful where Piper is genuinely installed. Everywhere else these
// skip, rather than failing a build for a missing optional component.

test("produces real WAV audio when Piper is installed", async (t) => {
  const status = piperStatus();
  if (!status.available) {
    t.skip(`Piper is not installed here: ${status.reason}`);
    return;
  }

  const result = await synthesize("Systems are online.", { cadence: "measured" });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.format, "wav");
  // "RIFF....WAVE" — the header a browser needs to play this without being
  // told the model's sample rate.
  assert.equal(result.audio.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(result.audio.subarray(8, 12).toString("ascii"), "WAVE");
  // Header alone is 44 bytes; anything near that is silence dressed as speech.
  assert.ok(result.audio.length > 1000, `expected real audio, got ${result.audio.length} bytes`);
});

test("an unknown voice still speaks, in the default voice", async (t) => {
  const status = piperStatus();
  if (!status.available) {
    t.skip("Piper is not installed here");
    return;
  }

  const result = await synthesize("Testing.", { voiceId: "en_XX-nobody-high" });

  // Falling back rather than failing: a reply is worth hearing in some voice.
  // The response says which one was used, so nothing is claimed falsely.
  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.voice : "", status.voice.id);
});

test("cadence actually changes the audio", async (t) => {
  const status = piperStatus();
  if (!status.available) {
    t.skip("Piper is not installed here");
    return;
  }

  const line = "The first sentence. The second sentence.";
  const [deliberate, playful] = await Promise.all([
    synthesize(line, { cadence: "deliberate" }),
    synthesize(line, { cadence: "playful" })
  ]);

  assert.equal(deliberate.ok, true);
  assert.equal(playful.ok, true);
  if (!deliberate.ok || !playful.ok) return;

  // Deliberate holds a longer pause between sentences, so its audio is longer.
  // If these matched, the cadence would be decorative rather than real.
  assert.ok(
    deliberate.audio.length > playful.audio.length,
    `deliberate ${deliberate.audio.length} should exceed playful ${playful.audio.length}`
  );
});
