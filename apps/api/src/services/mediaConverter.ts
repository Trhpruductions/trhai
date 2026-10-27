import { execFile } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { ffmpegAvailable, ffmpegProgram } from "./ffmpegPath.js";
import { claimNames, fileStem } from "./madeFileNames.js";

// Changing a song, a recording or a video into another format, on this PC, with
// ffmpeg: convert it, pull the sound out of a video, or cut it down to a part.
//
// What it makes is a NEW file - never one that is there - and it is read back:
// ffmpeg is asked what is in the file it just wrote (is there sound, is there a
// picture where one was meant, is it the length it should be) and then to play
// all of it through to nowhere, so a file that was cut short or cannot be decoded
// is found out here and not by whoever opens it. An unreadable file is removed and
// said; one that differs from what was meant is kept, with a note to open it and
// look, and never called checked.
//
// Nothing here goes through a shell: ffmpeg is run with its arguments as a list,
// and only on local files (-protocol_whitelist file), so a name that looks like an
// address or a "concat:" is a file name and nothing more.

export type MediaFormat = "mp3" | "wav" | "m4a" | "flac" | "ogg" | "opus" | "mp4";
export type MediaQuality = "small" | "normal" | "high";

type FormatInfo = { kind: "audio" | "video"; label: string; codec: Record<MediaQuality, string[]> };

const same = (...args: string[]): Record<MediaQuality, string[]> => ({ small: args, normal: args, high: args });

/** What each format is, and how ffmpeg is told to write it at each quality. */
export const mediaFormats: Readonly<Record<MediaFormat, FormatInfo>> = {
  mp3: {
    kind: "audio", label: "MP3 audio",
    codec: { small: ["-c:a", "libmp3lame", "-b:a", "128k"], normal: ["-c:a", "libmp3lame", "-b:a", "192k"], high: ["-c:a", "libmp3lame", "-b:a", "320k"] }
  },
  wav: { kind: "audio", label: "WAV audio", codec: same("-c:a", "pcm_s16le") },
  m4a: {
    kind: "audio", label: "M4A audio",
    codec: { small: ["-c:a", "aac", "-b:a", "96k"], normal: ["-c:a", "aac", "-b:a", "160k"], high: ["-c:a", "aac", "-b:a", "256k"] }
  },
  flac: { kind: "audio", label: "FLAC audio", codec: same("-c:a", "flac") },
  ogg: {
    kind: "audio", label: "Ogg audio",
    codec: { small: ["-c:a", "libvorbis", "-q:a", "3"], normal: ["-c:a", "libvorbis", "-q:a", "5"], high: ["-c:a", "libvorbis", "-q:a", "8"] }
  },
  opus: {
    kind: "audio", label: "Opus audio",
    codec: { small: ["-c:a", "libopus", "-b:a", "64k"], normal: ["-c:a", "libopus", "-b:a", "96k"], high: ["-c:a", "libopus", "-b:a", "160k"] }
  },
  mp4: {
    kind: "video", label: "MP4 video",
    codec: {
      small: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"],
      normal: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"],
      high: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
    }
  }
};

export const mediaFormatList = Object.keys(mediaFormats) as MediaFormat[];

/** The file endings of what can be converted. */
export const mediaSourceEndings = [
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".aiff", ".aif",
  ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".mpg", ".mpeg", ".3gp", ".wmv"
] as const;

const aliases: Record<string, MediaFormat> = {
  wave: "wav", aac: "m4a", mpeg4: "mp4", "mpeg-4": "mp4", vorbis: "ogg", oga: "ogg", mpeg: "mp3", mpga: "mp3"
};

export type ParsedFormat = { ok: true; format: MediaFormat } | { ok: false; reason: string };

/** "mp3", ".MP3", "wave" and "aac" (which is made as M4A) are all formats; anything else is said, with what can be made. */
export function parseMediaFormat(value: unknown): ParsedFormat {
  const word = typeof value === "string" ? value.trim().toLowerCase().replace(/^\./, "").split(/[\s,/]+/)[0] ?? "" : "";
  if (!word) return { ok: false, reason: `Say what to make it into: ${mediaFormatList.join(", ")}.` };
  const format = (aliases[word] ?? word) as MediaFormat;
  if (format in mediaFormats) return { ok: true, format };
  return { ok: false, reason: `"${typeof value === "string" ? value.trim().slice(0, 30) : word}" is not a format this can make. It can make ${mediaFormatList.join(", ")}.` };
}

export type ParsedClock = { ok: true; seconds: number | undefined } | { ok: false; reason: string };

/** A point in the file: seconds ("90", "90s", "1.5"), or minutes and seconds ("1:30"), or hours too ("1:02:03"), or "1m30s". Nothing given is nothing. */
export function parseClock(value: unknown, what = "time"): ParsedClock {
  if (value === undefined || value === null || value === "") return { ok: true, seconds: undefined };
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? { ok: true, seconds: value } : { ok: false, reason: `The ${what} must be a number of seconds, from 0.` };
  }
  if (typeof value !== "string") return { ok: false, reason: `The ${what} must be seconds or minutes:seconds.` };
  const text = value.trim().toLowerCase();
  const failed: ParsedClock = { ok: false, reason: `"${value.trim().slice(0, 30)}" is not a ${what} this can read. Give seconds (90) or minutes:seconds (1:30).` };
  let match: RegExpExecArray | null;
  if ((match = /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)?$/.exec(text))) return { ok: true, seconds: Number(match[1]) };
  if ((match = /^(\d+):([0-5]\d)(?:\.(\d+))?$/.exec(text))) return { ok: true, seconds: Number(match[1]) * 60 + Number(`${match[2]}${match[3] ? `.${match[3]}` : ""}`) };
  if ((match = /^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d+))?$/.exec(text))) {
    return { ok: true, seconds: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(`${match[3]}${match[4] ? `.${match[4]}` : ""}`) };
  }
  if ((match = /^(\d+)\s*m(?:in(?:ute)?s?)?(?:\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?)?$/.exec(text))) {
    return { ok: true, seconds: Number(match[1]) * 60 + (match[2] ? Number(match[2]) : 0) };
  }
  return failed;
}

export function parseQuality(value: unknown): MediaQuality {
  const word = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (/^(?:small|smaller|low|compact|compress(?:ed)?|tiny)$/.test(word)) return "small";
  if (/^(?:high|best|max|maximum|lossless|top)$/.test(word)) return "high";
  return "normal";
}

/** 187 seconds as "3:07"; 3725 as "1:02:05". */
export function clockText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const secs = total % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
}

export type TrimPlan = { ok: true; start: number; length: number; trimmed: boolean } | { ok: false; reason: string };

/** Which part of a file of `duration` seconds is wanted, and how long it is. A file of unknown length can only be taken whole or from a start. */
export function planTrim(duration: number | null, start: number | undefined, end: number | undefined): TrimPlan {
  const from = start ?? 0;
  if (end !== undefined && end <= from) return { ok: false, reason: `It cannot end at ${clockText(end)} when it starts at ${clockText(from)}.` };
  if (duration === null) {
    return end === undefined ? { ok: true, start: from, length: 0, trimmed: from > 0 } : { ok: true, start: from, length: end - from, trimmed: true };
  }
  if (from >= duration) return { ok: false, reason: `It is only ${clockText(duration)} long, so it cannot start at ${clockText(from)}.` };
  const to = end === undefined ? duration : Math.min(end, duration);
  const length = to - from;
  if (length < 0.25) return { ok: false, reason: "That leaves less than a quarter of a second." };
  return { ok: true, start: from, length, trimmed: from > 0 || to < duration - 0.05 };
}

export type ConvertPlan = { source: string; output: string; format: MediaFormat; quality: MediaQuality; start: number; length: number; hasAudio: boolean };

/** The arguments ffmpeg is run with, as a list. Local files only; the first sound and, for a video, the first picture. */
export function ffmpegArgs(plan: ConvertPlan): string[] {
  const info = mediaFormats[plan.format];
  const args = ["-nostdin", "-hide_banner", "-v", "error", "-protocol_whitelist", "file"];
  if (plan.start > 0) args.push("-ss", String(plan.start));
  args.push("-i", plan.source);
  if (plan.length > 0) args.push("-t", String(plan.length));
  if (info.kind === "audio") {
    args.push("-vn", "-map", "0:a:0", "-map_metadata", "0");
  } else {
    // A video needs even dimensions for yuv420p; the sound is taken if there is any.
    args.push("-map", "0:v:0", ...(plan.hasAudio ? ["-map", "0:a:0"] : []), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2");
  }
  args.push(...info.codec[plan.quality], "-y", plan.output);
  return args;
}

// ------------------------------------------------------------------ looking inside a file

export type Probe = { ok: true; seconds: number | null; audio: boolean; video: boolean } | { ok: false; reason: string };

/** What `ffmpeg -i file` says about a file: how long, and whether it has sound and a picture (cover art is not a picture). */
export function parseProbe(stderr: string): Probe {
  const streams = stderr.split(/\r?\n/).filter((line) => /^\s*Stream #\d+:\d+/.test(line));
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (streams.length === 0 && !duration) {
    const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const reason = lines.filter((line) => !/^(?:ffmpeg version|built with|configuration:|lib\w+\s)/i.test(line)).slice(-1)[0] ?? "it could not be opened";
    return { ok: false, reason: reason.slice(0, 200) };
  }
  return {
    ok: true,
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
    audio: streams.some((line) => /: Audio:/.test(line)),
    video: streams.some((line) => /: Video:/.test(line) && !/attached pic/i.test(line))
  };
}

export type RunResult = { code: number | null; stderr: string; timedOut: boolean; spawnError?: string };
export type RunFfmpeg = (args: string[], options: { timeoutMs: number }) => Promise<RunResult>;

const runFfmpeg: RunFfmpeg = (args, { timeoutMs }) => new Promise((resolve) => {
  execFile(ffmpegProgram(), args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, _stdout, stderr) => {
    if (!error) return resolve({ code: 0, stderr: stderr ?? "", timedOut: false });
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    if (failure.killed) return resolve({ code: null, stderr: stderr ?? "", timedOut: true });
    if (typeof failure.code === "number") return resolve({ code: failure.code, stderr: stderr ?? "", timedOut: false });
    resolve({ code: null, stderr: stderr ?? "", timedOut: false, spawnError: failure.message });
  });
});

async function inspect(file: string, run: RunFfmpeg): Promise<Probe> {
  // Asked to read a file and make nothing, ffmpeg says what is in it and then exits with an error: that is the answer.
  const result = await run(["-hide_banner", "-protocol_whitelist", "file", "-i", file], { timeoutMs: 30_000 });
  if (result.spawnError) return { ok: false, reason: result.spawnError };
  if (result.timedOut) return { ok: false, reason: "ffmpeg took too long to look at it" };
  return parseProbe(result.stderr);
}

/** The last thing ffmpeg complained of, in a few words, or null when it said nothing. */
function lastComplaint(stderr: string): string | null {
  const line = stderr.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).slice(-1)[0];
  return line ? line.slice(0, 240) : null;
}

/** Plays a file through to nowhere. A video is only played from five seconds before its end: that is where a cut-short file shows. */
async function decodes(file: string, video: boolean, seconds: number | null, run: RunFfmpeg): Promise<string | null> {
  const tail = video && seconds !== null && seconds > 8 ? ["-sseof", "-5"] : [];
  const result = await run(["-nostdin", "-v", "error", "-protocol_whitelist", "file", ...tail, "-i", file, "-f", "null", "-"], { timeoutMs: video ? 120_000 : 300_000 });
  if (result.timedOut) return "ffmpeg took too long to play it through";
  if (result.spawnError) return result.spawnError;
  const complaint = lastComplaint(result.stderr);
  return result.code === 0 && !complaint ? null : (complaint ?? `ffmpeg stopped with code ${result.code}`);
}

// --------------------------------------------------------------------------- making one

export type MediaRequest = {
  /** The file to convert, as an absolute path the caller has already checked it may read. */
  source: string;
  to: MediaFormat;
  start?: number;
  end?: number;
  quality?: MediaQuality;
  /** What to call the new file; otherwise the source's own name. */
  title?: string;
};

export type MadeMedia = { name: string; path: string; bytes: number; format: MediaFormat; seconds: number | null; checked: boolean };

export type ConvertResult =
  | { ok: true; from: { name: string; seconds: number | null }; file: MadeMedia; trimmed: { start: number; length: number } | null; problems: string[] }
  | { ok: false; reason: string };

export type ConvertOptions = {
  /** For a test to stand in for ffmpeg. */
  run?: RunFfmpeg;
  /** For a test that has no ffmpeg to find. */
  ffmpegIsHere?: () => boolean;
};

const fileSize = (file: string): number => {
  try { return statSync(file).size; } catch { return 0; }
};

const mebibytes = (bytes: number): string => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Convert one file into `directory`, as a new file, and say what was made. */
export async function convertMedia(request: MediaRequest, directory: string, options: ConvertOptions = {}): Promise<ConvertResult> {
  const run = options.run ?? runFfmpeg;
  if (!(options.ffmpegIsHere ?? (() => ffmpegAvailable()))()) {
    return { ok: false, reason: "ffmpeg is not installed, and it is what changes one kind of file into another. Settings, Engine and models installs it." };
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
    return { ok: false, reason: `${sourceName} is not an audio or video file this can convert. It reads ${mediaSourceEndings.join(", ")}.` };
  }

  const look = await inspect(request.source, run);
  if (!look.ok) return { ok: false, reason: `ffmpeg could not read ${sourceName} (${look.reason.replace(/\.$/, "")}).` };
  const info = mediaFormats[request.to];
  if (info.kind === "audio" && !look.audio) return { ok: false, reason: `${sourceName} has no sound in it to make into ${info.label}.` };
  if (info.kind === "video" && !look.video) {
    return { ok: false, reason: `${sourceName} has no picture, so it cannot become a video. A music video can be made from a song with make_music_video.` };
  }
  const plan = planTrim(look.seconds, request.start, request.end);
  if (!plan.ok) return { ok: false, reason: plan.reason };

  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `The folder could not be made: ${error instanceof Error ? error.message : String(error)}.` };
  }
  let claimed: ReturnType<typeof claimNames<MediaFormat>>;
  try {
    claimed = claimNames(directory, fileStem(request.title ?? path.basename(sourceName, ending), "Converted"), [request.to]);
  } catch (error) {
    return { ok: false, reason: `Nothing could be written in that folder: ${error instanceof Error ? error.message : String(error)}.` };
  }
  if (!claimed) return { ok: false, reason: "There are too many files with that name already." };
  const output = claimed.files.get(request.to) as string;
  const name = path.basename(output);
  const giveUp = (reason: string): ConvertResult => {
    try { rmSync(output, { force: true }); } catch { /* an empty claim is not worth a second failure */ }
    return { ok: false, reason };
  };

  const converted = await run(
    ffmpegArgs({ source: request.source, output, format: request.to, quality: request.quality ?? "normal", start: plan.start, length: plan.trimmed ? plan.length : 0, hasAudio: look.audio }),
    { timeoutMs: info.kind === "video" ? 20 * 60_000 : 10 * 60_000 }
  );
  if (converted.timedOut) return giveUp(`It took too long (more than ${info.kind === "video" ? 20 : 10} minutes), so it was stopped and nothing was kept.`);
  if (converted.spawnError) return giveUp(`ffmpeg could not be started: ${converted.spawnError}.`);
  if (converted.code !== 0) {
    const complaint = lastComplaint(converted.stderr);
    return giveUp(`ffmpeg could not make ${info.label} from ${sourceName}${complaint ? `: ${complaint.replace(/\.$/, "")}` : ""}. Nothing was kept.`);
  }

  // Read back: what is in it, and all of it played through.
  const back = await inspect(output, run);
  if (!back.ok) return giveUp(`The ${info.label} was written but ffmpeg could not read it back (${back.reason.replace(/\.$/, "")}), so it was removed.`);
  if (info.kind === "audio" ? !back.audio : !back.video) return giveUp(`The ${info.label} was written with ${info.kind === "audio" ? "no sound" : "no picture"} in it, so it was removed.`);
  const broken = await decodes(output, info.kind === "video", back.seconds, run);
  if (broken) return giveUp(`The ${info.label} was written but does not play through (${broken.replace(/\.$/, "")}), so it was removed.`);

  const problems: string[] = [];
  const expected = plan.trimmed ? plan.length : look.seconds;
  let checked = true;
  if (expected !== null && back.seconds !== null && Math.abs(back.seconds - expected) > Math.max(0.6, expected * 0.03)) {
    checked = false;
    problems.push(`${name} is ${clockText(back.seconds)} long and should be about ${clockText(expected)}; open it and look before relying on it.`);
  }
  if (info.kind === "video" && look.audio && !back.audio) {
    checked = false;
    problems.push(`${name} has no sound, and the original had some; open it and look.`);
  }
  return {
    ok: true,
    from: { name: sourceName, seconds: look.seconds },
    file: { name, path: output, bytes: fileSize(output), format: request.to, seconds: back.seconds, checked },
    trimmed: plan.trimmed ? { start: plan.start, length: plan.length } : null,
    problems
  };
}

/** What to tell the person, from what was made: the file by where it is. */
export function describeMadeMedia(result: ConvertResult, show: (absolute: string) => string = (absolute) => absolute): string {
  if (!result.ok) return `${result.reason} Nothing was made.`;
  const { file, from } = result;
  const detail = [mediaFormats[file.format].label, file.seconds !== null ? clockText(file.seconds) : null].filter(Boolean).join(", ");
  const trimmed = result.trimmed ? ` - the part from ${clockText(result.trimmed.start)} for ${clockText(result.trimmed.length)}` : "";
  const lines = [
    `Made ${mediaFormats[file.format].label} from ${from.name}${trimmed}${file.checked ? ", read back and checked" : ""} (${mebibytes(file.bytes)}). It is saved here:`,
    `- ${show(file.path)} (${detail})`
  ];
  for (const problem of result.problems) lines.push(problem);
  lines.push("The original is untouched.");
  return lines.join("\n");
}
