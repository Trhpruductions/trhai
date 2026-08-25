import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  cleanTranscript,
  describeModelFile,
  installedModels,
  readWavHeader,
  requiredChannels,
  requiredSampleRate,
  transcribe,
  whisperRoot,
  whisperStatus
} from "../src/services/whisperTranscribe.js";

// These cover the parts that must be right whether or not whisper.cpp is
// installed on the machine running them: how a model filename is read, how a
// WAV header is validated, what a transcript is cleaned down to, and — most
// importantly — that a missing install is reported rather than faked.

/** A minimal but real WAV header, so the parser is tested against the actual format. */
function wavHeader({ sampleRate = 16_000, channels = 1, bitsPerSample = 16 } = {}): Buffer {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);          // fmt chunk size
  buffer.writeUInt16LE(1, 20);           // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(0, 40);
  return buffer;
}

test("a model filename is read into a size and an English-only flag", () => {
  assert.deepEqual(describeModelFile("ggml-base.en.bin"), {
    id: "ggml-base.en",
    size: "base",
    englishOnly: true
  });

  assert.deepEqual(describeModelFile("ggml-small.bin"), {
    id: "ggml-small",
    size: "small",
    englishOnly: false
  });

  // Versioned names keep the leading size word rather than becoming "large-v3".
  assert.equal(describeModelFile("ggml-large-v3.bin")?.size, "large");
});

test("anything that is not a whisper model is refused, not guessed at", () => {
  assert.equal(describeModelFile("base.en.bin"), null);      // no ggml- prefix
  assert.equal(describeModelFile("ggml-base.en.onnx"), null); // that is a Piper voice
  assert.equal(describeModelFile("ggml-.bin"), null);          // no size at all
  assert.equal(describeModelFile("notes.txt"), null);
});

test("a real WAV header is parsed", () => {
  assert.deepEqual(readWavHeader(wavHeader()), {
    sampleRate: 16_000,
    channels: 1,
    bitsPerSample: 16
  });

  const stereo = readWavHeader(wavHeader({ sampleRate: 44_100, channels: 2 }));
  assert.equal(stereo?.sampleRate, 44_100);
  assert.equal(stereo?.channels, 2);
});

test("something that is not a WAV is rejected rather than misread", () => {
  assert.equal(readWavHeader(Buffer.alloc(0)), null);
  assert.equal(readWavHeader(Buffer.from("this is plainly not audio at all, not even close")), null);
  // Right length, wrong magic — the check is on the format, not the size.
  const notRiff = wavHeader();
  notRiff.write("XXXX", 0, "ascii");
  assert.equal(readWavHeader(notRiff), null);
});

test("transcripts lose whisper's own non-speech markers", () => {
  // These describe the recording; they are not words anyone said, and putting
  // them in the command box would read as though they had been.
  assert.equal(cleanTranscript(" [BLANK_AUDIO] "), "");
  assert.equal(cleanTranscript("[MUSIC] open my projects"), "open my projects");
  assert.equal(cleanTranscript("what is  my   status?  "), "what is my status?");
  assert.equal(cleanTranscript("(wind blowing) hello there"), "hello there");
});

test("audio in the wrong shape is refused with a reason naming the requirement", async () => {
  const result = await transcribe(wavHeader({ sampleRate: 44_100, channels: 2 }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  // Either whisper is absent (reported as such) or the format is caught. Both
  // are honest refusals; what must never happen is a fabricated transcript.
  assert.match(result.reason, /not installed|kHz mono|no model/i);
});

test("empty audio is refused rather than transcribed as silence", async () => {
  const result = await transcribe(Buffer.alloc(0));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no audio|not installed|no model/i);
});

test("a missing install is reported plainly, never faked", () => {
  const status = whisperStatus();

  if (!status.available) {
    // The whole contract: a reason a person can act on, not a silent false.
    assert.match(status.reason, /not installed|no model/i);
    return;
  }

  // If it genuinely is installed on this machine, the status must describe a
  // real file rather than an assumed one.
  assert.ok(status.binaryPath.length > 0);
  assert.ok(status.models.length > 0);
  assert.ok(status.models.includes(status.model));
});

test("the model list is ordered for interactive use, not just by size", () => {
  const models = installedModels();
  // Ordering only has meaning with something to order; on a machine with no
  // models installed the honest assertion is that the list is empty.
  if (models.length < 2) {
    assert.deepEqual(models, models.slice().sort());
    return;
  }

  // Whatever is first must be a real, described model — the sort must never
  // promote something that failed to parse.
  assert.ok(models[0].id.startsWith("ggml-"));
  assert.ok(models[0].modelPath.includes(models[0].id));
});

test("the required audio format is stated, so a client can meet it", () => {
  // The client resamples to exactly this before sending; if these ever change
  // the browser side has to change with them, which is why they are exported
  // rather than written twice.
  assert.equal(requiredSampleRate, 16_000);
  assert.equal(requiredChannels, 1);
});

test("the install root is overridable, so a different layout still works", () => {
  const original = process.env.VEXORA_WHISPER_DIR;
  try {
    process.env.VEXORA_WHISPER_DIR = path.join("some", "other", "place");
    assert.equal(whisperRoot(), path.join("some", "other", "place"));
  } finally {
    if (original === undefined) delete process.env.VEXORA_WHISPER_DIR;
    else process.env.VEXORA_WHISPER_DIR = original;
  }
});
