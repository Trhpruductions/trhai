import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpegAvailable } from "./ffmpegPath.js";
import { runWhisper, type WhisperRun } from "./lyricTranscribe.js";
import { claimNames, fileStem } from "./madeFileNames.js";
import { clockText, inspectMedia, mediaSourceEndings, runFfmpeg, type RunFfmpeg } from "./mediaConverter.js";
import { cleanTranscript, whisperStatus, type WhisperStatus } from "./whisperTranscribe.js";

// Writing out a recording, on this PC: the speech in an audio or video file turned into text,
// or into subtitles, and saved beside it. ffmpeg makes the 16 kHz mono copy whisper.cpp reads,
// whisper.cpp hears it on the processor, and nothing leaves the PC.
//
// What it makes is a NEW file, never one that is there. Nothing is claimed on the disk until
// there are words to put in it, so a recording with no speech in it leaves nothing behind. And
// it is read back: what is on the disk has to be what was heard, or it is removed and said.

export type TranscriptFormat = "txt" | "srt" | "vtt";

export const transcriptFormats: Readonly<Record<TranscriptFormat, { label: string }>> = {
  txt: { label: "text file" },
  srt: { label: "SRT subtitles" },
  vtt: { label: "WebVTT subtitles" }
};

export const transcriptFormatList = Object.keys(transcriptFormats) as TranscriptFormat[];

const aliases: Record<string, TranscriptFormat> = {
  text: "txt", transcript: "txt", plain: "txt",
  subtitle: "srt", subtitles: "srt", captions: "srt", caption: "srt",
  webvtt: "vtt"
};

/** What the model asked for, as a format. Left out, a plain text transcript. */
export function parseTranscriptFormat(value: unknown): { ok: true; format: TranscriptFormat } | { ok: false; reason: string } {
  if (value === undefined || value === null || value === "") return { ok: true, format: "txt" };
  const asked = String(value).trim().replace(/^\./, "").toLowerCase();
  if (asked in transcriptFormats) return { ok: true, format: asked as TranscriptFormat };
  if (asked in aliases) return { ok: true, format: aliases[asked] };
  return { ok: false, reason: `"${String(value).slice(0, 40)}" is not a format this writes. It writes ${transcriptFormatList.join(", ")}.` };
}

/** whisper.cpp's arguments. Timestamps on the text only when the format is subtitles; the language is fixed only for an English-only model, which can do nothing else. */
export function transcribeArgs(options: { model: string; wav: string; prefix: string; format: TranscriptFormat; english: boolean }): string[] {
  return [
    "-m", options.model,
    "-f", options.wav,
    `-o${options.format}`,
    "-of", options.prefix,
    "-np",
    ...(options.format === "txt" ? ["-nt"] : []),
    "-l", options.english ? "en" : "auto"
  ];
}

type Cue = { timing: string; lines: string[] };

/** The timed cues of whisper's SRT or VTT, with what is not speech taken out of them: a cue that is only "[BLANK_AUDIO]" is no cue. */
function cuesIn(raw: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of raw.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    const spoken = lines.slice(at + 1).map(cleanTranscript).filter(Boolean);
    if (spoken.length > 0) cues.push({ timing: lines[at].trim(), lines: spoken });
  }
  return cues;
}

/** What whisper wrote, as the file to keep, with what is not speech taken out. Empty when no speech was heard. */
export function tidyTranscript(raw: string, format: TranscriptFormat): string {
  if (format === "txt") {
    const lines = raw.split(/\r?\n/).map(cleanTranscript).filter(Boolean);
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
  }
  const cues = cuesIn(raw);
  if (cues.length === 0) return "";
  if (format === "srt") return `${cues.map((cue, index) => `${index + 1}\n${cue.timing}\n${cue.lines.join("\n")}\n`).join("\n")}`;
  return `WEBVTT\n\n${cues.map((cue) => `${cue.timing}\n${cue.lines.join("\n")}\n`).join("\n")}`;
}

/** Only the words that were said, whatever the format: no cue numbers, no times. */
export function spokenWords(tidied: string, format: TranscriptFormat): string {
  return format === "txt" ? tidied.replace(/\s+/g, " ").trim() : cuesIn(tidied).flatMap((cue) => cue.lines).join(" ");
}

function excerptOf(words: string, limit = 200): string {
  if (words.length <= limit) return words;
  const cut = words.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}...`;
}

export type TranscribeRequest = {
  /** The recording, as an absolute path the caller has already checked it may read. */
  source: string;
  format: TranscriptFormat;
  /** What to call the new file; otherwise the recording's own name. */
  title?: string;
};

export type MadeTranscript = { name: string; path: string; bytes: number; format: TranscriptFormat; words: number };

export type TranscribeResult =
  | { ok: true; from: { name: string; seconds: number | null }; file: MadeTranscript; excerpt: string }
  | { ok: false; reason: string };

export type TranscribeOptions = {
  /** The turn's Stop. A long recording can take minutes, and Stop has to end it. */
  signal?: AbortSignal;
  /** Stand-ins for a test. */
  run?: RunFfmpeg;
  whisper?: WhisperRun;
  status?: WhisperStatus;
  ffmpegIsHere?: () => boolean;
};

/** How long whisper is allowed: twice the recording and a minute over, so that a slow PC finishes and a stuck one is stopped. */
const allowedMs = (seconds: number | null) => (seconds === null ? 60 * 60_000 : Math.max(120_000, (seconds * 2 + 60) * 1000));

const stopped = "It was stopped before it finished.";

export async function transcribeFile(request: TranscribeRequest, directory: string, options: TranscribeOptions = {}): Promise<TranscribeResult> {
  const status = options.status ?? whisperStatus();
  if (!status.available) return { ok: false, reason: `Writing out a recording needs Listening. ${status.reason}` };
  if (!(options.ffmpegIsHere ?? (() => ffmpegAvailable()))()) {
    return { ok: false, reason: "ffmpeg is not installed, and it is what reads the recording. Settings, Engine and models, installs it." };
  }

  const sourceName = path.basename(request.source);
  let sourceSize: number;
  try {
    const info = statSync(request.source);
    if (info.isDirectory()) return { ok: false, reason: `${sourceName} is a folder, not a file.` };
    sourceSize = info.size;
  } catch {
    return { ok: false, reason: `There is no file at ${request.source}.` };
  }
  if (sourceSize === 0) return { ok: false, reason: `${sourceName} is empty.` };
  const ending = path.extname(sourceName).toLowerCase();
  if (!(mediaSourceEndings as readonly string[]).includes(ending)) {
    return { ok: false, reason: `${sourceName} is not an audio or video file. This reads ${mediaSourceEndings.join(", ")}.` };
  }

  const run = options.run ?? runFfmpeg;
  const look = await inspectMedia(request.source, run);
  if (!look.ok) return { ok: false, reason: `ffmpeg could not read ${sourceName} (${look.reason.replace(/\.$/, "")}).` };
  if (!look.audio) return { ok: false, reason: `${sourceName} has no sound in it to write out.` };
  if (options.signal?.aborted) return { ok: false, reason: stopped };

  const workDir = mkdtempSync(path.join(tmpdir(), "trhai-transcribe-"));
  try {
    const wav = path.join(workDir, "speech.wav");
    const prefix = path.join(workDir, "heard");
    const converted = await run(
      ["-y", "-v", "error", "-nostdin", "-protocol_whitelist", "file", "-i", request.source, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
      { timeoutMs: 10 * 60_000 }
    );
    if (converted.timedOut) return { ok: false, reason: "Reading the recording took too long (more than 10 minutes), so it was stopped." };
    if (converted.spawnError) return { ok: false, reason: `ffmpeg could not be started: ${converted.spawnError}.` };
    if (converted.code !== 0) return { ok: false, reason: `ffmpeg could not read the sound in ${sourceName}.` };
    if (options.signal?.aborted) return { ok: false, reason: stopped };

    const heard = await (options.whisper ?? runWhisper)(
      status.binaryPath,
      transcribeArgs({ model: status.model.modelPath, wav, prefix, format: request.format, english: status.model.englishOnly }),
      // The program's own folder: the Windows build keeps its DLLs beside it.
      { cwd: path.dirname(status.binaryPath), timeoutMs: allowedMs(look.seconds), signal: options.signal }
    );
    if (heard.aborted) return { ok: false, reason: stopped };
    if (heard.timedOut) return { ok: false, reason: "Listening took too long, so it was stopped." };
    if (heard.code !== 0) {
      const complaint = heard.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-1)[0];
      return { ok: false, reason: `whisper.cpp could not write out ${sourceName}${complaint ? `: ${complaint.slice(0, 200).replace(/\.$/, "")}` : ""}.` };
    }

    let raw: string;
    try {
      raw = readFileSync(`${prefix}.${request.format}`, "utf8");
    } catch {
      return { ok: false, reason: `whisper.cpp finished without writing anything for ${sourceName}.` };
    }
    const tidied = tidyTranscript(raw, request.format);
    const words = spokenWords(tidied, request.format);
    if (!words) return { ok: false, reason: `No speech was heard in ${sourceName}.` };

    try {
      mkdirSync(directory, { recursive: true });
    } catch (error) {
      return { ok: false, reason: `The folder could not be made: ${error instanceof Error ? error.message : String(error)}.` };
    }
    let claimed: ReturnType<typeof claimNames<TranscriptFormat>>;
    try {
      claimed = claimNames(directory, fileStem(request.title ?? path.basename(sourceName, ending), "Transcript"), [request.format]);
    } catch (error) {
      return { ok: false, reason: `Nothing could be written in that folder: ${error instanceof Error ? error.message : String(error)}.` };
    }
    if (!claimed) return { ok: false, reason: "There are too many files with that name already." };
    const output = claimed.files.get(request.format) as string;
    const giveUp = (reason: string): TranscribeResult => {
      try { rmSync(output, { force: true }); } catch { /* an empty claim is not worth a second failure */ }
      return { ok: false, reason };
    };

    try {
      writeFileSync(output, tidied, "utf8");
    } catch (error) {
      return giveUp(`It could not be saved: ${error instanceof Error ? error.message : String(error)}.`);
    }
    let back: string;
    try {
      back = readFileSync(output, "utf8");
    } catch {
      return giveUp("It was written but could not be read back, so it was removed.");
    }
    if (back !== tidied) return giveUp("What was saved is not what was heard, so it was removed.");

    return {
      ok: true,
      from: { name: sourceName, seconds: look.seconds },
      file: { name: path.basename(output), path: output, bytes: Buffer.byteLength(tidied), format: request.format, words: words.split(" ").length },
      excerpt: excerptOf(words)
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** What to tell the person, from what was made: the file by where it is, and enough of the words to see it heard them. */
export function describeTranscript(result: TranscribeResult, show: (absolute: string) => string = (absolute) => absolute): string {
  if (!result.ok) return `${result.reason} Nothing was made.`;
  const { file, from } = result;
  const length = from.seconds !== null ? `${clockText(from.seconds)}, ` : "";
  return [
    `Wrote down what is said in ${from.name} (${length}about ${file.words.toLocaleString("en-US")} words), read back and checked. It is saved here:`,
    `- ${show(file.path)} (${transcriptFormats[file.format].label})`,
    `It begins: "${result.excerpt}"`,
    "The recording is untouched."
  ].join("\n");
}
