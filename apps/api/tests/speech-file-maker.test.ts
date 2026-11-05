import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Reading text into an audio file: the text is cut at the right places, the voice asked for is the voice used, what is
// spoken is joined and read back, and every way it can go wrong is said in words with nothing left behind. The first part
// runs with stand-ins for the voice and the converter; the last makes real speech with the real voice, where there is one.

const {
  bracketedNoteIn, chooseVoice, describeMadeSpeech, joinWavs, longestSpeech, makeSpeechFile, parseWav, peakOf, secondsOf, speechFormats, splitForSpeech, wavFile
} = await import("../src/services/speechFileMaker.js");
const { piperStatus } = await import("../src/services/piperSpeech.js");
const { ffmpegAvailable, ffmpegProgram } = await import("../src/services/ffmpegPath.js");
type NeuralVoice = import("../src/services/piperSpeech.js").NeuralVoice;
type PiperStatus = import("../src/services/piperSpeech.js").PiperStatus;
type SynthesisResult = import("../src/services/piperSpeech.js").SynthesisResult;
type Wav = import("../src/services/speechFileMaker.js").Wav;

const root = mkdtempSync(path.join(tmpdir(), "trhai-speech-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const folder = () => { counter += 1; return path.join(root, `case-${counter}`); };

// ------------------------------------------------------------------------------ stand-ins

const voice = (id: string, name: string): NeuralVoice => ({ id, name, locale: id.split("-")[0], quality: "high", gender: null, modelPath: `C:\\fake\\${id}.onnx` });
const voices = [voice("en_GB-jarvis-high", "Jarvis"), voice("en_US-ryan-high", "Ryan"), voice("en_GB-cori-high", "Cori"), voice("en_GB-alan-medium", "Alan"), voice("en_US-amy-medium", "Amy")];
const status = (): PiperStatus => ({ available: true, voice: voices[3], voices, binaryPath: "piper.exe" });

/** A tone as a 22.05 kHz mono WAV, as long as it takes to say `characters` letters at fifteen a second. */
function tone(seconds: number, amplitude = 8000, sampleRate = 22_050): Buffer {
  const samples = Buffer.alloc(Math.round(seconds * sampleRate) * 2);
  for (let index = 0; index < samples.length / 2; index += 1) samples.writeInt16LE(Math.round(Math.sin(index / 20) * amplitude), index * 2);
  return wavFile({ sampleRate, channels: 1 }, samples);
}

type Call = { text: string; voiceId?: string; rate?: number };
function fakeVoice(make: (text: string, call: number) => SynthesisResult | Promise<SynthesisResult> = (text) => ({ ok: true, audio: tone(Math.max(0.5, text.length / 15)), format: "wav", voice: "en_GB-alan-medium" })) {
  const calls: Call[] = [];
  const speak = async (text: string, options: { voiceId?: string; rate?: number } = {}) => {
    calls.push({ text, voiceId: options.voiceId, rate: options.rate });
    return make(text, calls.length);
  };
  return { speak: speak as never, calls };
}

// ------------------------------------------------------------------------- cutting the text up

test("a paragraph is a piece, a break between paragraphs is a longer pause, and markdown is not spoken", () => {
  const pieces = splitForSpeech("# The Garden\n\nThe **first** paragraph, with a [link](https://example.com).\n\n- one thing\n- another thing\n\nThe last one.");
  assert.deepEqual(pieces.map((piece) => piece.text), ["The Garden.", "The first paragraph, with a link.", "one thing. another thing.", "The last one."]);
  assert.deepEqual(pieces.map((piece) => piece.pauseAfter), [0.6, 0.6, 0.6, 0]);
  assert.deepEqual(splitForSpeech(""), []);
  assert.deepEqual(splitForSpeech("  \n\n  \n"), []);
  assert.deepEqual(splitForSpeech("Just one line."), [{ text: "Just one line.", pauseAfter: 0 }]);
});

test("sentences are gathered up to the limit and no piece is longer, and nothing is lost or reordered", () => {
  const sentences = Array.from({ length: 40 }, (_, index) => `This is sentence number ${index + 1}, said plainly.`);
  const pieces = splitForSpeech(sentences.join(" "), 200);
  assert.ok(pieces.length > 4);
  for (const piece of pieces) assert.ok(piece.text.length <= 200, `${piece.text.length} letters`);
  assert.equal(pieces.map((piece) => piece.text).join(" "), sentences.join(" "));
  // A breath between the parts of one paragraph, none after the last.
  assert.ok(pieces.slice(0, -1).every((piece) => piece.pauseAfter === 0.2));
  assert.equal(pieces[pieces.length - 1].pauseAfter, 0);
});

test("a sentence too long for one go is cut at its commas, or failing that at a space", () => {
  const long = `${Array.from({ length: 30 }, (_, index) => `clause number ${index + 1}`).join(", ")}.`;
  const cut = splitForSpeech(long, 120);
  assert.ok(cut.length > 3);
  for (const piece of cut) assert.ok(piece.text.length <= 120);
  assert.equal(cut.map((piece) => piece.text).join(" ").replace(/\s+/g, " "), long);
  const wordsOnly = splitForSpeech(Array.from({ length: 60 }, (_, index) => `word${index}`).join(" "), 80);
  for (const piece of wordsOnly) assert.ok(piece.text.length <= 80);
  assert.equal(wordsOnly.map((piece) => piece.text).join(" "), Array.from({ length: 60 }, (_, index) => `word${index}`).join(" "));
  const unbroken = splitForSpeech("x".repeat(300), 100);
  assert.deepEqual(unbroken.map((piece) => piece.text.length), [100, 100, 100]);
  // A comma near the start is not a place to cut when a space near the limit is: "Well," alone would be a one-word piece.
  const early = splitForSpeech("Well, one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen.", 40);
  assert.equal(early[0].text, "Well, one two three four five six seven");
  for (const piece of early) assert.ok(piece.text.length <= 40);
});

test("a piece is as long as the limit and no longer, counting the space that joins two sentences", () => {
  // Ten letters and ten letters, a space between: twenty-one.
  assert.deepEqual(splitForSpeech("aaaaaaaaa. bbbbbbbbb.", 20).map((piece) => piece.text), ["aaaaaaaaa.", "bbbbbbbbb."]);
  assert.deepEqual(splitForSpeech("aaaaaaaaa. bbbbbbbbb.", 21).map((piece) => piece.text), ["aaaaaaaaa. bbbbbbbbb."]);
});

test("a note to the reader left in brackets is found, and a label or a citation is not", () => {
  assert.equal(bracketedNoteIn("Hello. [insert the rest of the story here]"), "[insert the rest of the story here]");
  assert.equal(bracketedNoteIn("Dear [add your name], welcome."), "[add your name]");
  assert.equal(bracketedNoteIn("He sighed [laughs softly] and went on."), "[laughs softly]", "a stage direction would be read out too");
  for (const fine of ["[Chorus] La la la.", "[Chorus]\nLa la la.\n[Verse 2]\nMore words.", "As he said [sic], it was so.", "See note [1] and [23].", "A list [a, b].", "No brackets at all.", "Empty [] ones", "[ ]"]) {
    assert.equal(bracketedNoteIn(fine), null, fine);
  }
});

// --------------------------------------------------------------------------- choosing a voice

test("a voice is found by its id, its name or a part of either, and nothing asked for is the usual one", () => {
  const id = (wanted: string | undefined) => { const choice = chooseVoice(wanted, voices); return choice.ok ? (choice.voice?.id ?? "usual") : choice.reason; };
  assert.equal(id(undefined), "usual");
  assert.equal(id(""), "usual");
  assert.equal(id("   "), "usual");
  assert.equal(id("Jarvis"), "en_GB-jarvis-high");
  assert.equal(id("jarvis"), "en_GB-jarvis-high");
  assert.equal(id("the Jarvis voice".replace("the ", "")), "en_GB-jarvis-high", "'Jarvis voice'");
  assert.equal(id("en_US-ryan-high"), "en_US-ryan-high");
  assert.equal(id("amy"), "en_US-amy-medium");
  assert.equal(id("al"), "en_GB-alan-medium", "the start of a name");
  assert.equal(id("cori"), "en_GB-cori-high");
});

test("an exact name beats a longer one that merely starts with it", () => {
  const close = [voice("en_GB-al-low", "Al"), voice("en_GB-alan-medium", "Alan")];
  const choice = chooseVoice("al", close);
  assert.ok(choice.ok);
  assert.equal(choice.voice?.id, "en_GB-al-low");
  const longer = chooseVoice("ala", close);
  assert.ok(longer.ok);
  assert.equal(longer.voice?.id, "en_GB-alan-medium");
});

test("a name is matched from its start, even where the id does not carry it, and not from its middle", () => {
  const odd = [voice("en_GB-semaine-medium", "Prudence"), voice("en_GB-alba-medium", "Alba")];
  const start = chooseVoice("pru", odd);
  assert.ok(start.ok);
  assert.equal(start.voice?.id, "en_GB-semaine-medium");
  const middle = chooseVoice("den", odd);
  assert.equal(middle.ok, false);
  assert.match((middle as { reason: string }).reason, /There is no voice called "den" here\. The voices are Prudence, Alba\./);
});

test("a voice that is not here is said, with the ones that are, and a vague one asks which", () => {
  const nobody = chooseVoice("Morgan", voices);
  assert.equal(nobody.ok, false);
  assert.equal((nobody as { reason: string }).reason, 'There is no voice called "Morgan" here. The voices are Jarvis, Ryan, Cori, Alan, Amy.');
  const vague = chooseVoice("en_GB", voices);
  assert.equal(vague.ok, false);
  assert.match((vague as { reason: string }).reason, /fits more than one voice \(en_GB-jarvis-high, en_GB-cori-high, en_GB-alan-medium\)\. Say which\./);
});

// ------------------------------------------------------------------------------------ WAV files

test("a WAV is written and read back as the same format and the same samples", () => {
  const samples = Buffer.alloc(2000);
  for (let index = 0; index < 1000; index += 1) samples.writeInt16LE(index * 7 - 3000, index * 2);
  const file = wavFile({ sampleRate: 22_050, channels: 1 }, samples);
  assert.equal(file.length, 44 + 2000);
  // The fields a player reads: the size of the rest of the file, bytes a second, and the bytes in one frame.
  assert.equal(file.readUInt32LE(4), file.length - 8);
  assert.equal(file.readUInt32LE(28), 22_050 * 2);
  assert.equal(file.readUInt16LE(32), 2);
  const stereoFile = wavFile({ sampleRate: 8000, channels: 2 }, Buffer.alloc(32));
  assert.equal(stereoFile.readUInt32LE(28), 8000 * 2 * 2);
  assert.equal(stereoFile.readUInt16LE(32), 4);
  const stereo = parseWav(wavFile({ sampleRate: 8000, channels: 2 }, Buffer.alloc(8000 * 2 * 2 * 3))) as Wav;
  assert.equal(secondsOf(stereo), 3, "a second is a second however many channels carry it");
  const parsed = parseWav(file) as Wav;
  assert.deepEqual({ sampleRate: parsed.sampleRate, channels: parsed.channels, bits: parsed.bits }, { sampleRate: 22_050, channels: 1, bits: 16 });
  assert.deepEqual(parsed.data, samples);
  assert.ok(Math.abs(secondsOf(parsed) - 1000 / 22_050) < 1e-9);
  assert.equal(peakOf(parsed), 3993, "the loudest sample (index 999: 999 * 7 - 3000), whichever way it points");
  const negative = Buffer.alloc(4);
  negative.writeInt16LE(-9000, 0);
  negative.writeInt16LE(100, 2);
  assert.equal(peakOf(parseWav(wavFile({ sampleRate: 8000, channels: 1 }, negative)) as Wav), 9000, "and a loud one below zero counts as loud");
});

test("what is not a 16-bit PCM WAV is not read as one, and a length left unfilled means the rest of the file", () => {
  assert.equal(parseWav(Buffer.from("not a wav file at all, just some words padded out to be long enough for a header")), null);
  assert.equal(parseWav(Buffer.alloc(10)), null);
  const good = tone(0.1);
  const float = Buffer.from(good); float.writeUInt16LE(3, 20);
  assert.equal(parseWav(float), null, "float samples");
  const eightBit = Buffer.from(good); eightBit.writeUInt16LE(8, 34);
  assert.equal(parseWav(eightBit), null);
  const streamed = Buffer.from(good); streamed.writeUInt32LE(0xffffffff, 40);
  assert.equal((parseWav(streamed) as Wav).data.length, good.length - 44, "a writer that did not know the length");
  const odd = Buffer.concat([good, Buffer.from([1])]);
  odd.writeUInt32LE(0, 40);
  assert.equal((parseWav(odd) as Wav).data.length, good.length - 44, "a length of nothing is the rest of the file, and half a sample at the end is dropped");
  const cutShort = Buffer.concat([good, Buffer.from([1])]);
  cutShort.writeUInt32LE(1_000_000, 40);
  assert.equal((parseWav(cutShort) as Wav).data.length, good.length - 44, "a length longer than the file is the rest of the file, whole samples only");
  const extra = Buffer.concat([good.subarray(0, 36), Buffer.from("LIST\u0004\u0000\u0000\u0000abcd", "latin1"), good.subarray(36)]);
  assert.equal((parseWav(extra) as Wav).data.length, good.length - 44, "a chunk between the format and the data is stepped over");
  const padded = Buffer.concat([good.subarray(0, 36), Buffer.from("LIST\u0005\u0000\u0000\u0000abcde\u0000", "latin1"), good.subarray(36)]);
  assert.equal((parseWav(padded) as Wav).data.length, good.length - 44, "a chunk of an odd size is followed by a byte of padding");
});

test("pieces are joined with the pauses asked for, and only if they are the same kind of audio", () => {
  const a = parseWav(tone(1)) as Wav;
  const b = parseWav(tone(2)) as Wav;
  const c = parseWav(tone(0.5)) as Wav;
  const joined = joinWavs([a, b, c], [0.5, 1, 99]) as Wav;
  assert.ok(Math.abs(secondsOf(joined) - (1 + 0.5 + 2 + 1 + 0.5)) < 0.001, "no pause after the last, whatever is asked");
  assert.equal(joinWavs([a], [1])?.data.length, a.data.length);
  assert.equal(joinWavs([], []), null);
  assert.equal(joinWavs([a, { ...b, sampleRate: 16_000 }], [0]), null, "a different rate");
  assert.equal(joinWavs([a, { ...b, channels: 2 }], [0]), null);
});

// ---------------------------------------------------------------------- with stand-ins

test("text becomes a WAV named for its first words, in the voice asked for, as long as the pieces and pauses, and checked", async () => {
  const dir = folder();
  const speaker = fakeVoice();
  const result = await makeSpeechFile(
    { text: "Hello there, this is a test of the voice.\n\nAnd a second paragraph follows it.", voice: "Jarvis", format: "wav", rate: 1.25 },
    dir, { speak: speaker.speak, status, ffmpegIsHere: () => false }
  );
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.equal(result.file.name, "Hello there this is a test.wav");
  assert.equal(result.file.voice, "Jarvis");
  assert.equal(result.file.pieces, 2);
  assert.equal(result.file.checked, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(speaker.calls.map((call) => [call.voiceId, call.rate]), [["en_GB-jarvis-high", 1.25], ["en_GB-jarvis-high", 1.25]]);
  const written = parseWav(readFileSync(result.file.path)) as Wav;
  const expected = speaker.calls[0].text.length / 15 + 0.6 + speaker.calls[1].text.length / 15;
  assert.ok(Math.abs(secondsOf(written) - expected) < 0.05, `${secondsOf(written)} vs ${expected}`);
  assert.ok(Math.abs((result.file.seconds ?? 0) - expected) < 0.05);
  assert.ok(peakOf(written) > 1000);
  const text = describeMadeSpeech(result);
  assert.match(text, /^Made WAV audio of the text \(\d+ letters, read in the Jarvis voice, in 2 pieces\), read back and checked \(\d+ KB\)\. It is saved here:\n- .*Hello there this is a test\.wav \(WAV audio, 0:\d\d\)$/);
});

test("with ffmpeg the usual file is an MP3, made from the speech by the converter into the folder asked for, and the scratch is cleared", async () => {
  const dir = folder();
  const seen: Array<{ source: string; to: string; title?: string; existed: boolean; directory: string }> = [];
  const result = await makeSpeechFile({ text: "Read this out please.", title: "My Reading" }, dir, {
    speak: fakeVoice().speak, status, ffmpegIsHere: () => true,
    convert: (async (request: { source: string; to: string; title?: string }, directory: string) => {
      seen.push({ source: request.source, to: request.to, title: request.title, existed: existsSync(request.source), directory });
      const file = path.join(directory, "My Reading.mp3");
      writeFileSync(file, "mp3 bytes");
      return { ok: true, from: { name: "speech.wav", seconds: 1.5 }, file: { name: "My Reading.mp3", path: file, bytes: 9, format: "mp3", seconds: 1.4, checked: true }, trimmed: null, problems: [] };
    }) as never
  });
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.equal(result.file.format, "mp3");
  assert.equal(result.file.name, "My Reading.mp3");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].to, "mp3");
  assert.equal(seen[0].title, "My Reading");
  assert.equal(seen[0].directory, dir);
  assert.equal(seen[0].existed, true, "the converter was given a real WAV");
  assert.equal(existsSync(path.dirname(seen[0].source)), false, "and the scratch folder is gone");
  assert.match(describeMadeSpeech(result), /\(MP3 audio, 0:01\)/);
});

test("what the converter says is wrong with its result is carried through, not hidden", async () => {
  const result = await makeSpeechFile({ text: "Read this out please." }, folder(), {
    speak: fakeVoice().speak, status, ffmpegIsHere: () => true,
    convert: (async (_request: unknown, directory: string) => {
      const file = path.join(directory, "x.mp3");
      writeFileSync(file, "x");
      return { ok: true, from: { name: "speech.wav", seconds: 3 }, file: { name: "x.mp3", path: file, bytes: 1, format: "mp3", seconds: 1, checked: false }, trimmed: null, problems: ["x.mp3 is 0:01 long and should be about 0:03; open it and look before relying on it."] };
    }) as never
  });
  assert.ok(result.ok);
  assert.equal(result.file.checked, false);
  assert.match(describeMadeSpeech(result), /open it and look/);
  assert.doesNotMatch(describeMadeSpeech(result), /read back and checked/);
  const failed = await makeSpeechFile({ text: "Read this out please." }, folder(), {
    speak: fakeVoice().speak, status, ffmpegIsHere: () => true,
    convert: (async () => ({ ok: false, reason: "ffmpeg could not make MP3 audio from speech.wav: boom." })) as never
  });
  assert.equal(failed.ok, false);
  assert.match((failed as { reason: string }).reason, /boom/);
});

test("without ffmpeg the usual file is a WAV, and another format is refused rather than quietly swapped", async () => {
  const dir = folder();
  const wav = await makeSpeechFile({ text: "No ffmpeg here." }, dir, { speak: fakeVoice().speak, status, ffmpegIsHere: () => false });
  assert.ok(wav.ok);
  assert.equal(wav.file.format, "wav");
  const refused = await makeSpeechFile({ text: "No ffmpeg here.", format: "mp3" }, dir, { speak: fakeVoice().speak, status, ffmpegIsHere: () => false });
  assert.equal(refused.ok, false);
  assert.match((refused as { reason: string }).reason, /A MP3 needs ffmpeg, which is not installed.*A WAV can be made without it/);
});

test("what cannot be made is refused in words before anything is spoken or written", async () => {
  const dir = folder();
  const silent = fakeVoice();
  const base = { speak: silent.speak, status, ffmpegIsHere: () => false };
  const reason = (result: Awaited<ReturnType<typeof makeSpeechFile>>) => (result as { reason: string }).reason;

  assert.match(reason(await makeSpeechFile({ text: "   \n\n  " }, dir, base)), /There was no text to read\./);
  assert.match(reason(await makeSpeechFile({ text: "word ".repeat(3000) }, dir, base)), new RegExp(`up to ${longestSpeech.toLocaleString("en-US")} \\(about thirteen minutes`));
  assert.match(reason(await makeSpeechFile({ text: "Hello." , voice: "Morgan" }, dir, base)), /There is no voice called "Morgan" here\. The voices are Jarvis, Ryan, Cori, Alan, Amy\./);
  assert.match(reason(await makeSpeechFile({ text: "Hello." }, dir, { ...base, status: () => ({ available: false, reason: "There is no Piper voice installed." }) })), /There is no Piper voice installed\./);
  assert.equal(silent.calls.length, 0, "the voice was never asked");
  assert.equal(existsSync(dir), false, "no folder was made");
  assert.equal(speechFormats.includes("mp4" as never), false, "a video cannot be made from text");
});

test("a voice that fails part-way, or makes silence, or makes something that is not a WAV, leaves nothing behind", async () => {
  const text = `${"A first paragraph that has some words in it. ".repeat(2)}\n\n${"A second paragraph that has more words. ".repeat(2)}\n\nA third.`;
  const dir = folder();
  const failing = fakeVoice((_text, call) => call === 2 ? { ok: false, reason: "The voice crashed." } : { ok: true, audio: tone(1), format: "wav", voice: "x" });
  const midway = await makeSpeechFile({ text, format: "wav" }, dir, { speak: failing.speak, status, ffmpegIsHere: () => false });
  assert.equal(midway.ok, false);
  assert.equal((midway as { reason: string }).reason, "The voice could not read part 2 of 3: The voice crashed.");
  assert.equal(existsSync(dir), false, "nothing was written");

  const silent = await makeSpeechFile({ text, format: "wav" }, dir, { speak: fakeVoice(() => ({ ok: true, audio: tone(1, 0), format: "wav", voice: "x" })).speak, status, ffmpegIsHere: () => false });
  assert.equal((silent as { reason: string }).reason, "The voice made silence, so nothing was made.");
  const quiet = await makeSpeechFile({ text, format: "wav" }, dir, { speak: fakeVoice(() => ({ ok: true, audio: tone(1, 100), format: "wav", voice: "x" })).speak, status, ffmpegIsHere: () => false });
  assert.equal(quiet.ok, false, "a whisper below hearing is silence too");

  const notWav = await makeSpeechFile({ text, format: "wav" }, dir, { speak: fakeVoice(() => ({ ok: true, audio: Buffer.from("MP3 or something"), format: "wav", voice: "x" })).speak, status, ffmpegIsHere: () => false });
  assert.match((notWav as { reason: string }).reason, /something that is not a WAV file/);

  let calls = 0;
  const unlike = await makeSpeechFile({ text, format: "wav" }, dir, {
    speak: fakeVoice(() => ({ ok: true, audio: tone(1, 8000, calls++ === 0 ? 22_050 : 16_000), format: "wav", voice: "x" })).speak, status, ffmpegIsHere: () => false
  });
  assert.match((unlike as { reason: string }).reason, /not all the same kind of audio/);
  assert.equal(existsSync(dir), false);
});

test("speech far too short or too long for its text is kept, said to be wrong, and never called checked", async () => {
  const dir = folder();
  const hurried = await makeSpeechFile({ text: "A sentence that is a good deal longer than a fraction of a second.", format: "wav" }, dir, {
    speak: fakeVoice(() => ({ ok: true, audio: tone(0.4), format: "wav", voice: "x" })).speak, status, ffmpegIsHere: () => false
  });
  assert.ok(hurried.ok);
  assert.equal(hurried.file.checked, false);
  assert.match(hurried.problems[0], /is 0:00 for \d+ letters, which is not how long it should be; listen to it before relying on it/);
  assert.equal(existsSync(hurried.file.path), true);
  assert.doesNotMatch(describeMadeSpeech(hurried), /read back and checked/);
});

test("a name is never taken twice, and a title names the file in a name every system accepts", async () => {
  const dir = folder();
  const options = { speak: fakeVoice().speak, status, ffmpegIsHere: () => false };
  const first = await makeSpeechFile({ text: "Same words.", format: "wav" }, dir, options);
  const second = await makeSpeechFile({ text: "Same words.", format: "wav" }, dir, options);
  const titled = await makeSpeechFile({ text: "Same words.", format: "wav", title: 'Chapter 1: "The Start" / part?' }, dir, options);
  assert.ok(first.ok && second.ok && titled.ok);
  assert.deepEqual([first.file.name, second.file.name, titled.file.name], ["Same words.wav", "Same words (2).wav", "Chapter 1 The Start part.wav"]);
  assert.deepEqual(readdirSync(dir).sort(), ["Chapter 1 The Start part.wav", "Same words (2).wav", "Same words.wav"]);
});

// --------------------------------------------------------------------- the real voice

const real = piperStatus();
const skipVoice = real.available ? false : "there is no voice here";
const skipFfmpeg = real.available && ffmpegAvailable() ? false : "there is no voice or no ffmpeg here";

test("the real voice reads a sentence into a WAV that is the right length, audible, and plays through in ffmpeg too", { skip: skipVoice }, async () => {
  const dir = folder();
  const result = await makeSpeechFile({ text: "Hello from TRH AI. This is a test of the voice, read into a file.", format: "wav" }, dir, { ffmpegIsHere: () => false });
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.equal(result.file.checked, true, result.problems.join(" "));
  assert.ok((result.file.seconds ?? 0) > 2 && (result.file.seconds ?? 0) < 15, `${result.file.seconds} seconds`);
  const wav = parseWav(readFileSync(result.file.path)) as Wav;
  assert.ok(peakOf(wav) > 1000, "there is sound in it");
  if (ffmpegAvailable()) execFileSync(ffmpegProgram(), ["-v", "error", "-i", result.file.path, "-f", "null", "-"], { stdio: "pipe", timeout: 60_000 });
});

test("the real voice reads in the voice asked for, and two paragraphs make a longer file than one", { skip: skipVoice }, async () => {
  const dir = folder();
  const one = await makeSpeechFile({ text: "The quick brown fox jumps over the lazy dog.", format: "wav", voice: "jarvis" }, dir, { ffmpegIsHere: () => false });
  const two = await makeSpeechFile({ text: "The quick brown fox jumps over the lazy dog.\n\nThe quick brown fox jumps over the lazy dog.", format: "wav", voice: "jarvis" }, dir, { ffmpegIsHere: () => false });
  assert.ok(one.ok && two.ok);
  assert.equal(one.file.voice, "Jarvis");
  assert.ok((two.file.seconds ?? 0) > (one.file.seconds ?? 0) * 1.8, `${two.file.seconds} vs ${one.file.seconds}`);
  assert.equal(two.file.pieces, 2);
  const slow = await makeSpeechFile({ text: "The quick brown fox jumps over the lazy dog.", format: "wav", voice: "jarvis", rate: 0.5 }, dir, { ffmpegIsHere: () => false });
  assert.ok(slow.ok);
  assert.ok((slow.file.seconds ?? 0) > (one.file.seconds ?? 0) * 1.4, "half speed is longer");
});

test("the real voice and the real converter make an MP3", { skip: skipFfmpeg }, async () => {
  const dir = folder();
  const result = await makeSpeechFile({ text: "This one is an MP3, made from the voice by ffmpeg." }, dir);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.equal(result.file.format, "mp3");
  assert.equal(result.file.checked, true, result.problems.join(" "));
  assert.ok((result.file.seconds ?? 0) > 2);
  assert.equal(path.extname(result.file.name), ".mp3");
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".wav")), [], "the WAV it was made from is not left in the folder");
});
