import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { speakableText } from "@ascend/shared";
import { ffmpegAvailable } from "./ffmpegPath.js";
import { claimNames, fileStem } from "./madeFileNames.js";
import { clockText, convertMedia } from "./mediaConverter.js";
import { piperStatus, synthesize, type NeuralVoice, type PiperStatus } from "./piperSpeech.js";

// Reading text out into an audio file, with the voice that is already on this PC.
//
// The text is cleaned the way a reply is before it is spoken (no asterisks, no link addresses), cut into pieces the voice
// can take in one go - at paragraphs, then sentences, then commas - spoken piece by piece, and joined with a short pause
// between them, a longer one between paragraphs. A WAV is written as it is; every other format is made from it by the
// converter, which reads each file back. A WAV is read back here: is it a WAV, is it as long as the pieces added up to,
// and is there any sound in it - a voice that made silence is a failure, not a file.

export const speechFormats = ["wav", "mp3", "m4a", "flac", "ogg", "opus"] as const;
export type SpeechFormat = typeof speechFormats[number];

/** About thirteen minutes of speech: long enough for an article, short enough to finish. */
export const longestSpeech = 12_000;
/** Under the voice's own limit for one go, so no piece is ever refused for length. */
const pieceLimit = 1_500;
/** A sample this loud (of 32,767) is sound; the quietest real speech is far above it. */
const audibleAbove = 300;

/**
 * A note to the reader left in [brackets] - "[insert the rest of the story here]", "[add your name]" - which a voice would
 * read out as words. A label or a citation ("[Chorus]", "[Verse 2]", "[sic]", "[1]") has at most one real word in it and is let through.
 */
export function bracketedNoteIn(text: string): string | null {
  for (const match of text.matchAll(/\[([^\]\n]{2,80})\]/g)) {
    const inside = match[1].trim();
    if (inside.split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word)).length >= 2) return `[${inside}]`;
  }
  return null;
}

// ------------------------------------------------------------------------- cutting the text up

export type SpeechPiece = { text: string; pauseAfter: number };

/** A sentence too long for one go, cut at its commas, or failing that at a space, into parts no longer than `limit`. */
function cutLong(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) return [sentence];
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const comma = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    const space = window.lastIndexOf(" ");
    const at = comma >= limit / 2 ? comma + 1 : space > 0 ? space : limit;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * The text as pieces to speak: a paragraph at a time, its sentences gathered up to `limit` letters, each followed by the
 * pause it deserves - a breath after a piece that is only part of a paragraph, a longer one after a paragraph.
 */
export function splitForSpeech(text: string, limit = pieceLimit): SpeechPiece[] {
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)
    .map((paragraph) => speakableText(paragraph))
    .filter((paragraph) => paragraph.length > 0);
  const pieces: SpeechPiece[] = [];
  paragraphs.forEach((paragraph, index) => {
    const sentences = paragraph.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [paragraph];
    let current = "";
    for (const sentence of sentences) {
      for (const part of cutLong(sentence, limit)) {
        if (current && current.length + 1 + part.length > limit) {
          pieces.push({ text: current, pauseAfter: 0.2 });
          current = "";
        }
        current = current ? `${current} ${part}` : part;
      }
    }
    if (current) pieces.push({ text: current, pauseAfter: index === paragraphs.length - 1 ? 0 : 0.6 });
  });
  return pieces;
}

// ----------------------------------------------------------------------------- choosing a voice

export type VoiceChoice = { ok: true; voice: NeuralVoice | null } | { ok: false; reason: string };

/**
 * The installed voice a person means: by its id ("en_GB-jarvis-high"), its name ("Jarvis"), or a part of either ("jarvis").
 * Nothing asked for is the usual voice. A voice that is not installed is said, with the ones that are - not swapped
 * for another without a word, which is what asking for it by name must not mean.
 */
export function chooseVoice(wanted: string | undefined, installed: readonly NeuralVoice[]): VoiceChoice {
  const word = (wanted ?? "").trim().toLowerCase().replace(/\s+voice$/, "");
  if (!word) return { ok: true, voice: null };
  const exact = installed.filter((voice) => voice.id.toLowerCase() === word || voice.name.toLowerCase() === word);
  const found = exact.length > 0 ? exact : installed.filter((voice) => voice.id.toLowerCase().includes(word) || voice.name.toLowerCase().startsWith(word));
  if (found.length === 1) return { ok: true, voice: found[0] };
  const names = installed.map((voice) => voice.name).join(", ");
  if (found.length === 0) return { ok: false, reason: `There is no voice called "${(wanted ?? "").trim().slice(0, 40)}" here. The voices are ${names}.` };
  return { ok: false, reason: `"${(wanted ?? "").trim().slice(0, 40)}" fits more than one voice (${found.map((voice) => voice.id).join(", ")}). Say which.` };
}

// ------------------------------------------------------------------------------------- WAV files

export type Wav = { sampleRate: number; channels: number; bits: number; data: Buffer };

/** A PCM WAV, read: its format and its samples. Null for anything else. */
export function parseWav(buffer: Buffer): Wav | null {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let format: { sampleRate: number; channels: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buffer.length) {
      const kind = buffer.readUInt16LE(body);
      if (kind !== 1) return null;
      format = { channels: buffer.readUInt16LE(body + 2), sampleRate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!format || format.bits !== 16 || format.channels < 1 || format.sampleRate < 1) return null;
      // A writer that did not know the length leaves it as 0 or all ones: the data is then the rest of the file.
      const end = size === 0 || size === 0xffffffff || body + size > buffer.length ? buffer.length : body + size;
      const length = end - body;
      return { ...format, data: buffer.subarray(body, body + length - (length % (2 * format.channels))) };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** A PCM WAV file of `data`, 16-bit. */
export function wavFile(format: Pick<Wav, "sampleRate" | "channels">, data: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * format.channels * 2, 28);
  header.writeUInt16LE(format.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export const secondsOf = (wav: Wav): number => wav.data.length / (2 * wav.channels * wav.sampleRate);

/** The loudest sample, from 0 to 32,767. */
export function peakOf(wav: Wav): number {
  let peak = 0;
  for (let at = 0; at + 1 < wav.data.length; at += 2) peak = Math.max(peak, Math.abs(wav.data.readInt16LE(at)));
  return peak;
}

/** Pieces of speech joined, with the silences asked for between them. They must all be the same kind of WAV. */
export function joinWavs(parts: readonly Wav[], pauses: readonly number[]): Wav | null {
  const first = parts[0];
  if (!first) return null;
  const chunks: Buffer[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.sampleRate !== first.sampleRate || part.channels !== first.channels || part.bits !== first.bits) return null;
    chunks.push(part.data);
    const pause = index < parts.length - 1 ? pauses[index] ?? 0 : 0;
    if (pause > 0) chunks.push(Buffer.alloc(Math.round(pause * first.sampleRate) * first.channels * 2));
  }
  return { sampleRate: first.sampleRate, channels: first.channels, bits: 16, data: Buffer.concat(chunks) };
}

// ------------------------------------------------------------------------------- making one

export type SpeechRequest = {
  text: string;
  /** An installed voice, by id or name; nothing is the usual one. */
  voice?: string;
  /** Nothing asked for is MP3 where ffmpeg is, and WAV where it is not. */
  format?: SpeechFormat;
  /** 1 is the voice's own pace. */
  rate?: number;
  title?: string;
};

export type MadeSpeech = {
  name: string; path: string; bytes: number; format: SpeechFormat; seconds: number | null;
  characters: number; voice: string; pieces: number; checked: boolean;
};

export type SpeechResult = { ok: true; file: MadeSpeech; problems: string[] } | { ok: false; reason: string };

export type SpeechOptions = {
  /** For a test to stand in for the voice. */
  speak?: typeof synthesize;
  /** For a test to say what voices there are. */
  status?: () => PiperStatus;
  /** For a test to stand in for the converter. */
  convert?: typeof convertMedia;
  ffmpegIsHere?: () => boolean;
};

const fileSize = (file: string): number => {
  try { return statSync(file).size; } catch { return 0; }
};

const mebibytes = (bytes: number): string => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The first few words, for a name: "Hello there, this is a test of the voice" is "Hello there this is a test". */
function firstWords(text: string): string {
  return text.replace(/[^\p{L}\p{N}\s'-]+/gu, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
}

/** Read `request.text` aloud into a new file in `directory`, and say what was made. */
export async function makeSpeechFile(request: SpeechRequest, directory: string, options: SpeechOptions = {}): Promise<SpeechResult> {
  const status = (options.status ?? piperStatus)();
  if (!status.available) return { ok: false, reason: status.reason };

  const raw = typeof request.text === "string" ? request.text : "";
  const pieces = splitForSpeech(raw);
  if (pieces.length === 0) return { ok: false, reason: "There was no text to read." };
  const characters = pieces.reduce((sum, piece) => sum + piece.text.length, 0);
  if (characters > longestSpeech) {
    return { ok: false, reason: `That is ${characters.toLocaleString("en-US")} letters; up to ${longestSpeech.toLocaleString("en-US")} (about thirteen minutes of speech) can be read into one file.` };
  }

  const ffmpegHere = (options.ffmpegIsHere ?? (() => ffmpegAvailable()))();
  const format: SpeechFormat = request.format ?? (ffmpegHere ? "mp3" : "wav");
  if (format !== "wav" && !ffmpegHere) {
    return { ok: false, reason: `A ${format.toUpperCase()} needs ffmpeg, which is not installed (Settings, Engine and models installs it). A WAV can be made without it.` };
  }
  const chosen = chooseVoice(request.voice, status.voices);
  if (!chosen.ok) return { ok: false, reason: chosen.reason };
  const voice = chosen.voice ?? status.voice;

  const speak = options.speak ?? synthesize;
  const spoken: Wav[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const made = await speak(pieces[index].text, { voiceId: voice.id, rate: request.rate });
    if (!made.ok) return { ok: false, reason: `The voice could not read ${pieces.length > 1 ? `part ${index + 1} of ${pieces.length}` : "it"}: ${made.reason.replace(/\.$/, "")}.` };
    const wav = parseWav(made.audio);
    if (!wav) return { ok: false, reason: "The voice made something that is not a WAV file, so nothing was made." };
    spoken.push(wav);
  }
  const whole = joinWavs(spoken, pieces.map((piece) => piece.pauseAfter));
  if (!whole) return { ok: false, reason: "The pieces of speech were not all the same kind of audio, so they could not be joined. Nothing was made." };
  if (peakOf(whole) < audibleAbove) return { ok: false, reason: "The voice made silence, so nothing was made." };
  const seconds = secondsOf(whole);

  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `The folder could not be made: ${error instanceof Error ? error.message : String(error)}.` };
  }
  const title = request.title ?? firstWords(raw);
  const stem = fileStem(title, "Speech");
  const problems: string[] = [];
  const note = { characters, voice: voice.name, pieces: pieces.length };
  // Much faster than anyone speaks, or much slower, means something went wrong in the reading.
  if (seconds < characters / 60 || seconds > characters * 2) {
    problems.push(`The speech is ${clockText(seconds)} for ${characters.toLocaleString("en-US")} letters, which is not how long it should be; listen to it before relying on it.`);
  }

  if (format === "wav") {
    let claimed: ReturnType<typeof claimNames<SpeechFormat>>;
    try {
      claimed = claimNames(directory, stem, ["wav"]);
    } catch (error) {
      return { ok: false, reason: `Nothing could be written in that folder: ${error instanceof Error ? error.message : String(error)}.` };
    }
    if (!claimed) return { ok: false, reason: "There are too many files with that name already." };
    const file = claimed.files.get("wav") as string;
    const giveUp = (reason: string): SpeechResult => {
      try { rmSync(file, { force: true }); } catch { /* an empty claim is not worth a second failure */ }
      return { ok: false, reason };
    };
    try {
      writeFileSync(file, wavFile(whole, whole.data));
    } catch (error) {
      return giveUp(`It could not be written: ${error instanceof Error ? error.message : String(error)}.`);
    }
    // Read back: a WAV, as long as it should be, with sound in it.
    let back: Wav | null;
    try {
      back = parseWav(readFileSync(file));
    } catch (error) {
      return giveUp(`It was written but could not be opened again (${error instanceof Error ? error.message : String(error)}), so it was removed.`);
    }
    if (!back) return giveUp("It was written but is not a WAV file when read back, so it was removed.");
    if (Math.abs(secondsOf(back) - seconds) > 0.05 || peakOf(back) < audibleAbove) {
      return giveUp("It was written but is not what was made - the wrong length, or silent - so it was removed.");
    }
    return { ok: true, file: { name: path.basename(file), path: file, bytes: fileSize(file), format, seconds: secondsOf(back), ...note, checked: problems.length === 0 }, problems };
  }

  // Any other format is made from a WAV by the converter, which reads its own file back.
  const scratch = mkdtempSync(path.join(tmpdir(), "trhai-speech-"));
  try {
    const source = path.join(scratch, "speech.wav");
    writeFileSync(source, wavFile(whole, whole.data));
    const converted = await (options.convert ?? convertMedia)({ source, to: format, title: stem }, directory, { ffmpegIsHere: () => true });
    if (!converted.ok) return { ok: false, reason: converted.reason };
    problems.push(...converted.problems);
    return { ok: true, file: { name: converted.file.name, path: converted.file.path, bytes: converted.file.bytes, format, seconds: converted.file.seconds, ...note, checked: converted.file.checked && problems.length === 0 }, problems };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const kindLabels: Record<SpeechFormat, string> = { wav: "WAV audio", mp3: "MP3 audio", m4a: "M4A audio", flac: "FLAC audio", ogg: "Ogg audio", opus: "Opus audio" };

/** What to tell the person, from what was made: the file by where it is. */
export function describeMadeSpeech(result: SpeechResult, show: (absolute: string) => string = (absolute) => absolute): string {
  if (!result.ok) return `${result.reason} Nothing was made.`;
  const { file } = result;
  const detail = [kindLabels[file.format], file.seconds !== null ? clockText(file.seconds) : null].filter(Boolean).join(", ");
  const lines = [
    `Made ${kindLabels[file.format]} of the text (${file.characters.toLocaleString("en-US")} letters, read in the ${file.voice} voice${file.pieces > 1 ? `, in ${file.pieces} pieces` : ""})${file.checked ? ", read back and checked" : ""} (${mebibytes(file.bytes)}). It is saved here:`,
    `- ${show(file.path)} (${detail})`
  ];
  for (const problem of result.problems) lines.push(problem);
  return lines.join("\n");
}
