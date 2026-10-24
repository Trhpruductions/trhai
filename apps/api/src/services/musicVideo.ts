// Making a music video from a song: listen to it, find the words, draw it, and
// only then say it worked.
//
//   1. Probe the file (length, title and artist tags, cover art) and decode it.
//   2. Analyse it: where the beats are, how loud it is, where it changes.
//   3. Find the lyrics: the ones a person pasted, timed to the singing by
//      whisper.cpp, or what whisper hears when none were given.
//   4. Write the pictures and the subtitle file ffmpeg needs, then run ffmpeg
//      with the song's spectrum streamed in as a video (musicVideoGraph.ts).
//   5. Check the file that came out - length, streams, and that its end plays -
//      before it is put in the workspace, and make a thumbnail.
//
// Nothing here runs on the graphics card, needs an account, or leaves the PC.
// The pieces that are only arithmetic are in audioAnalysis.ts, lyricTiming.ts,
// musicVideoLook.ts and musicVideoCaptions.ts, and are tested without ffmpeg.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyse, analysisRate, visualTrack, type Analysis } from "./audioAnalysis.js";
import { ffmpegAvailable, ffmpegProgram } from "./ffmpegPath.js";
import { hearWords, type Heard } from "./lyricTranscribe.js";
import { cleanLyrics, planLyrics, type LyricLine, type LyricPlan, type LyricsTiming, type Word } from "./lyricTiming.js";
import { buildCaptions } from "./musicVideoCaptions.js";
import {
  controlHeight, controlWidth, choosePalette, circleMask, discMask, dustLayer, geometryFor, hueExpression, radialMaps, writeControlFrame,
  type Geometry, type Palette
} from "./musicVideoLook.js";
import { coverArgs, coverRadius, extractCoverArgs, renderArgs, videoFps, workFiles } from "./musicVideoGraph.js";
import { whisperStatus } from "./whisperTranscribe.js";
import { resolveInWorkspace } from "./workspace.js";

// ---------------------------------------------------------------- what is asked, and what comes back

export type MusicVideoRequest = {
  /** The song, as a path relative to the workspace. */
  audio: string;
  title?: string;
  artist?: string;
  /** Lyrics to put on screen, as pasted: they are timed to the singing. */
  lyrics?: string;
  /** "none" leaves the words off; otherwise the pasted lyrics are used, or else whatever can be heard. */
  words?: "auto" | "none";
  /** A palette's id, or nothing to let the song choose. */
  palette?: string;
  height?: 720 | 1080;
  /** Show the song's own cover art in the disc, when it has some. On unless set to false. */
  cover?: boolean;
  /** Make only the first this-many seconds, to try the look. */
  previewSeconds?: number;
  /** Make it again in this folder under music-videos, replacing what is there. */
  folder?: string;
};

export type Stage = "preparing" | "listening" | "lyrics" | "drawing" | "finishing";

export type Progress = { stage: Stage; /** 0 to 1 across the whole job. */ fraction: number; message: string };

export type MusicVideoResult = {
  /** Relative to the workspace. */
  folder: string;
  video: string;
  thumbnail: string;
  title: string;
  artist: string;
  seconds: number;
  height: 720 | 1080;
  bpm: number | null;
  palette: string;
  lyricLines: number;
  lyricsTiming: LyricsTiming;
  cover: boolean;
  preview: boolean;
  warnings: string[];
  bytes: number;
};

export type Outcome = { ok: true; result: MusicVideoResult } | { ok: false; reason: string; cancelled?: boolean };

export type RunContext = {
  signal: AbortSignal;
  report: (progress: Progress) => void;
  env?: NodeJS.ProcessEnv;
};

export const audioExtensions = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".aiff"];
/** The longest song it will make a video for: past this the render takes the better part of an hour. */
export const longestSongSeconds = 15 * 60;
export const shortestSongSeconds = 3;
export const biggestAudioBytes = 400 * 1024 * 1024;

class Stop extends Error {
  constructor(readonly reason: string, readonly cancelled = false) { super(reason); }
}

// ---------------------------------------------------------------- reading what ffmpeg says about a file

export type StreamFacts = {
  kind: "audio" | "video" | "other";
  codec: string;
  width?: number;
  height?: number;
  /** For a picture: how its colours are stored, such as "yuv420p". "yuvj420p" is the full-range kind, which some players show wrongly. */
  pixelFormat?: string;
  attachedPicture: boolean;
};

export type MediaFacts = {
  /** Seconds, or null if the file does not say. */
  duration: number | null;
  tags: { title?: string; artist?: string; album?: string };
  streams: StreamFacts[];
};

/** What `ffmpeg -i file` writes to stderr, read into facts. (It then complains that there is no output file, which is expected.) */
export function parseProbe(stderr: string): MediaFacts {
  const lines = stderr.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith("Input #0"));
  const facts: MediaFacts = { duration: null, tags: {}, streams: [] };
  if (start < 0) return facts;
  let inContainerTags = true;
  for (const line of lines.slice(start + 1)) {
    const duration = /^\s+Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
    if (duration) {
      facts.duration = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
      inContainerTags = false;
      continue;
    }
    const stream = /^\s+Stream #0:\d+(?:\[0x[0-9a-fA-F]+\])?(?:\([^)]*\))?: (Audio|Video|Subtitle|Data|Attachment): ([^\s,(]+)(.*)$/.exec(line);
    if (stream) {
      inContainerTags = false;
      const kind = stream[1] === "Audio" ? "audio" : stream[1] === "Video" ? "video" : "other";
      const size = kind === "video" ? /,\s(\d{2,5})x(\d{2,5})[\s,[]/.exec(stream[3]) : null;
      const format = kind === "video" ? /,\s(yuvj?\d{3}p\w*|nv\d+|gbrp\w*|rgba?\w*|bgra?\w*|gray\w*|pal8)\b/.exec(stream[3]) : null;
      facts.streams.push({
        kind,
        codec: stream[2],
        width: size ? Number(size[1]) : undefined,
        height: size ? Number(size[2]) : undefined,
        pixelFormat: format ? format[1] : undefined,
        attachedPicture: stream[3].includes("(attached pic)")
      });
      continue;
    }
    // Tags of the file itself sit four spaces in, before the first stream; a stream's own are six in.
    const tag = inContainerTags ? /^ {4}([A-Za-z_]+)\s*:\s?(.*)$/.exec(line) : null;
    if (tag) {
      const key = tag[1].toLowerCase();
      const value = tag[2].trim();
      if (value && (key === "title" || key === "artist" || key === "album")) facts.tags[key] = value;
    }
  }
  return facts;
}

// ---------------------------------------------------------------- running programs

type Collected = { code: number | null; stdout: Buffer; stderr: string; aborted: boolean };

/** Runs a program to the end and returns what it wrote. Stops it if the signal fires. */
function collect(program: string, args: string[], options: { cwd?: string; signal: AbortSignal; keepStdout?: boolean }): Promise<Collected> {
  return new Promise((resolve) => {
    if (options.signal.aborted) { resolve({ code: null, stdout: Buffer.alloc(0), stderr: "", aborted: true }); return; }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: error instanceof Error ? error.message : String(error), aborted: false });
      return;
    }
    const out: Buffer[] = [];
    let stderr = "";
    let aborted = false;
    child.stdout?.on("data", (chunk: Buffer) => { if (options.keepStdout) out.push(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-60_000); });
    const stop = () => { aborted = true; child.kill(); };
    options.signal.addEventListener("abort", stop, { once: true });
    const finish = (code: number | null, extra = "") => {
      options.signal.removeEventListener("abort", stop);
      resolve({ code, stdout: Buffer.concat(out), stderr: stderr + extra, aborted });
    };
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
}

const tail = (text: string, length = 500) => text.trim().slice(-length);

/** The filters and encoders a music video needs. A build lacking one fails deep inside a graph with a message about something else. */
const neededFilters = ["split", "crop", "scale", "format", "drawgrid", "movie", "loop", "fps", "remap", "gradients", "blend", "gblur", "colorchannelmixer", "hue", "vignette", "subtitles", "fade", "pad"];
const neededEncoders = ["libx264", "aac"];
const capabilityCache = new Map<string, string[]>();

/**
 * What a build lacks, from the text of `ffmpeg -filters` and `-encoders`. Their
 * flag columns have been two characters and three in different versions, so a
 * list that does not read as a list (too few names found) is not taken to mean
 * that every filter is missing: nothing is reported then, and a graph that
 * cannot run says so itself.
 */
export function missingFrom(filtersText: string, encodersText: string): string[] {
  const filters = new Set([...filtersText.matchAll(/^\s*[TSC.]{2,3}\s+(\w+)\s/gm)].map((m) => m[1]));
  const encoders = new Set([...encodersText.matchAll(/^\s*[VAS.][A-Z.]{5}\s+(\w+)\s/gm)].map((m) => m[1]));
  if (filters.size < 40 || encoders.size < 5) return [];
  return [...neededFilters.filter((name) => !filters.has(name)).map((name) => `the ${name} filter`), ...neededEncoders.filter((name) => !encoders.has(name)).map((name) => `the ${name} encoder`)];
}

export async function missingFromFfmpeg(program: string, signal: AbortSignal): Promise<string[]> {
  const known = capabilityCache.get(program);
  if (known) return known;
  const filters = await collect(program, ["-hide_banner", "-filters"], { signal, keepStdout: true });
  const encoders = await collect(program, ["-hide_banner", "-encoders"], { signal, keepStdout: true });
  if (filters.code !== 0 || encoders.code !== 0) return [];
  const missing = missingFrom(filters.stdout.toString(), encoders.stdout.toString());
  capabilityCache.set(program, missing);
  return missing;
}

export function forgetFfmpegCapabilities(): void {
  capabilityCache.clear();
}

// ---------------------------------------------------------------- names

/** A folder name for a title: lower case, letters and numbers, joined with hyphens. */
export function slugOf(title: string): string {
  const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return slug || "music-video";
}

/** A title from a file name, when the file has none of its own: "01 - neon_highway.mp3" is "neon highway". */
export function titleFromFileName(file: string): string {
  const base = path.basename(file, path.extname(file)).replace(/[_]+/g, " ").replace(/^\s*\d{1,3}\s*[-.)]\s*/, "").replace(/\s+/g, " ").trim();
  return base || "Untitled";
}

export const musicVideosFolder = "music-videos";
/** Where an uploaded song waits until a video has been made from it. */
export const uploadsFolder = `${musicVideosFolder}/_uploads`;

function folderFor(request: MusicVideoRequest, title: string, preview: boolean): { relative: string; absolute: string } | null {
  if (request.folder) {
    const given = request.folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!given.startsWith(`${musicVideosFolder}/`) || given.includes("..")) return null;
    const absolute = resolveInWorkspace(given);
    return absolute ? { relative: given, absolute } : null;
  }
  const slug = `${slugOf(title)}${preview ? "-preview" : ""}`;
  // A preview is replaced each time; a video gets a folder of its own, so that making another with the same title does not overwrite the first.
  for (let n = 1; n < 1000; n += 1) {
    const relative = `${musicVideosFolder}/${n === 1 ? slug : `${slug}-${n}`}`;
    const absolute = resolveInWorkspace(relative);
    if (!absolute) return null;
    if (preview || !existsSync(absolute)) return { relative, absolute };
  }
  return null;
}

// ---------------------------------------------------------------- the lyrics

/**
 * The words for the video: listens to the song if it can (whisper.cpp, on the
 * CPU), then lets lyricTiming.ts decide what to show. When it cannot listen, the
 * reason is passed on and is what the person is told.
 */
async function findLyrics(
  request: MusicVideoRequest,
  analysis: Analysis,
  duration: number,
  fullDuration: number,
  workDir: string,
  program: string,
  audioPath: string,
  context: RunContext,
  progress: (fraction: number, message: string) => void
): Promise<LyricPlan> {
  if (request.words === "none") return { lines: [], source: "none", timing: "none", warnings: [] };
  const pasted = cleanLyrics(request.lyrics ?? "");
  const first = analysis.sections[0];
  const last = analysis.sections[analysis.sections.length - 1];
  const plan = (heard: { words: Word[]; timed: boolean } | null, why?: string) => planLyrics({
    pasted, heard, why, duration, fullDuration,
    singingFrom: first?.kind === "intro" ? first.end : undefined,
    singingTo: last?.kind === "outro" ? last.start : undefined
  });

  const status = whisperStatus();
  if (!status.available) return plan(null, "TRH AI cannot listen to the song until Listening is installed (Settings, Engine and models).");

  const message = pasted.length ? "Listening to the singing to time your lyrics" : "Listening for the words";
  progress(0, message);
  // A 16 kHz mono copy: what whisper.cpp reads.
  const wav = path.join(workDir, "heard.wav");
  const made = await collect(program, ["-y", "-v", "error", "-nostdin", "-i", audioPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", duration.toFixed(3), wav], { signal: context.signal });
  if (made.aborted) throw new Stop("Cancelled.", true);
  if (made.code !== 0 || !existsSync(wav)) return plan(null, "the song could not be prepared for listening.");
  const heard: Heard = await hearWords({ wav, workDir, duration, signal: context.signal, onProgress: (fraction) => progress(fraction, message) });
  if (!heard.ok) {
    if (heard.cancelled) throw new Stop("Cancelled.", true);
    return plan(null, `listening did not work (${heard.reason}).`);
  }
  return plan({ words: heard.words, timed: heard.timed });
}

// ---------------------------------------------------------------- drawing

type RenderOutcome = { ok: true } | { ok: false; reason: string; cancelled?: boolean };

/** Runs ffmpeg with the control video streamed to its stdin, and reports the frames it has finished. */
async function runRender(program: string, args: string[], cwd: string, levels: Uint8Array, light: Uint8Array, bands: number, frames: number, signal: AbortSignal, onFrame: (frame: number) => void): Promise<RenderOutcome> {
  if (signal.aborted) return { ok: false, reason: "Cancelled.", cancelled: true };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(program, args, { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    return { ok: false, reason: `ffmpeg could not be started: ${error instanceof Error ? error.message : String(error)}` };
  }
  // The PC stays usable while it draws.
  try { if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not worth failing for */ }

  let stderr = "";
  let aborted = false;
  let exited = false;
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
  let pending = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    const rows = pending.split(/\r?\n/);
    pending = rows.pop() ?? "";
    for (const row of rows) {
      const frame = /^frame=(\d+)$/.exec(row.trim());
      if (frame) onFrame(Number(frame[1]));
    }
  });
  child.stdin?.on("error", () => { /* ffmpeg went away; the exit code says why */ });
  const stop = () => { aborted = true; child.kill(); };
  signal.addEventListener("abort", stop, { once: true });
  const closed = new Promise<number | null>((resolve) => {
    child.on("error", (error) => { stderr += error.message; exited = true; resolve(null); });
    child.on("close", (code) => { exited = true; resolve(code); });
  });

  // The control video, a frame at a time, as fast as ffmpeg takes it.
  const frame = new Uint8Array(controlWidth * controlHeight);
  for (let f = 0; f < frames && !exited && !aborted; f += 1) {
    writeControlFrame(frame, levels.subarray(f * bands, (f + 1) * bands), light[f], bands);
    const room = child.stdin?.write(Buffer.from(frame));
    if (room === false) {
      await Promise.race([new Promise<void>((resolve) => child.stdin?.once("drain", () => resolve())), closed]);
    }
  }
  child.stdin?.end();
  const code = await closed;
  signal.removeEventListener("abort", stop);
  if (aborted) return { ok: false, reason: "Cancelled.", cancelled: true };
  if (code !== 0) return { ok: false, reason: `ffmpeg stopped while drawing the video (code ${code}). ${tail(stderr)}`.trim() };
  return { ok: true };
}

// ---------------------------------------------------------------- checking what came out

/** What is wrong with a finished file, as plain sentences; none when it is what was asked for. */
export function videoProblems(facts: MediaFacts, expected: { seconds: number; width: number; height: number }): string[] {
  const problems: string[] = [];
  const video = facts.streams.find((stream) => stream.kind === "video" && !stream.attachedPicture);
  const audio = facts.streams.find((stream) => stream.kind === "audio");
  if (!video) problems.push("the file has no picture");
  else if (video.codec !== "h264") problems.push(`the picture is ${video.codec}, not h264`);
  else if (video.width !== expected.width || video.height !== expected.height) problems.push(`the picture is ${video.width}x${video.height}, not ${expected.width}x${expected.height}`);
  else if (video.pixelFormat !== "yuv420p") problems.push(`the picture's colours are stored as ${video.pixelFormat ?? "something unknown"}, not yuv420p, which players do not all show right`);
  if (!audio) problems.push("the file has no sound");
  if (facts.duration === null) problems.push("the file does not say how long it is");
  else if (Math.abs(facts.duration - expected.seconds) > Math.max(0.6, expected.seconds * 0.02)) problems.push(`the file is ${facts.duration.toFixed(1)} seconds long, not ${expected.seconds.toFixed(1)}`);
  return problems;
}

/** The best moment for a thumbnail: the loudest one, among the lines of the lyrics if there are any, and not at the very start or end. */
export function thumbnailTime(analysis: Pick<Analysis, "intensity" | "duration">, lines: LyricLine[]): number {
  const duration = analysis.duration;
  if (duration <= 12) return duration * 0.4;
  const lo = duration * 0.15;
  const hi = duration * 0.85;
  const at = (seconds: number) => analysis.intensity[Math.min(analysis.intensity.length - 1, Math.max(0, Math.floor(seconds * 4)))] ?? 0;
  const candidates = lines.length > 0
    ? lines.map((line) => (line.start + line.end) / 2).filter((t) => t >= lo && t <= hi)
    : Array.from({ length: Math.max(1, Math.floor((hi - lo) / 0.5)) }, (_, i) => lo + i * 0.5);
  if (candidates.length === 0) return duration * 0.4;
  let best = candidates[0];
  for (const t of candidates) if (at(t) > at(best)) best = t;
  return best;
}

// ---------------------------------------------------------------- the whole thing

const percent = (a: number, b: number, fraction: number) => a + (b - a) * Math.max(0, Math.min(1, fraction));

export async function makeMusicVideo(request: MusicVideoRequest, context: RunContext): Promise<Outcome> {
  const env = context.env ?? process.env;
  const warnings: string[] = [];
  let workDir: string | null = null;
  const check = () => { if (context.signal.aborted) throw new Stop("Cancelled.", true); };
  const report = (stage: Stage, fraction: number, message: string) => context.report({ stage, fraction, message });

  try {
    // ---- before anything is spent: is it possible?
    if (!ffmpegAvailable(env)) return { ok: false, reason: "ffmpeg is not installed, and music videos need it. Settings, Engine and models, installs it." };
    const program = ffmpegProgram(env);
    const missing = await missingFromFfmpeg(program, context.signal);
    check();
    if (missing.length > 0) return { ok: false, reason: `This copy of ffmpeg lacks ${missing.join(" and ")}, which music videos need. Settings, Engine and models, installs one that has them.` };

    const audioPath = resolveInWorkspace(request.audio);
    if (!audioPath) return { ok: false, reason: "That song is outside the workspace." };
    if (!audioExtensions.includes(path.extname(audioPath).toLowerCase())) return { ok: false, reason: `That is not a song file this can read. It can read ${audioExtensions.join(", ")}.` };
    if (!existsSync(audioPath) || !statSync(audioPath).isFile()) return { ok: false, reason: "That song file is not there." };
    if (statSync(audioPath).size > biggestAudioBytes) return { ok: false, reason: "That song file is too big." };

    const height = request.height === 720 ? 720 : 1080;
    const geometry: Geometry = geometryFor(height);
    const preview = typeof request.previewSeconds === "number" && request.previewSeconds > 0;

    // ---- probe and decode
    report("preparing", 0, "Opening the song");
    const probe = await collect(program, ["-hide_banner", "-nostdin", "-i", audioPath], { signal: context.signal });
    check();
    const facts = parseProbe(probe.stderr);
    if (!facts.streams.some((stream) => stream.kind === "audio") || facts.duration === null) return { ok: false, reason: "That file could not be read as a song." };
    if (facts.duration > longestSongSeconds) return { ok: false, reason: `That song is ${Math.round(facts.duration / 60)} minutes long. The longest this can make a video for is ${longestSongSeconds / 60}.` };
    if (facts.duration < shortestSongSeconds) return { ok: false, reason: "That song is too short for a video." };

    const title = request.title?.trim() || facts.tags.title || titleFromFileName(audioPath);
    const artist = request.artist !== undefined ? request.artist.trim() : facts.tags.artist ?? "";
    const wanted = preview ? Math.min(facts.duration, Math.max(3, request.previewSeconds as number)) : facts.duration;

    const decoded = await collect(program, ["-v", "error", "-nostdin", "-i", audioPath, "-vn", "-t", wanted.toFixed(3), "-ac", "1", "-ar", String(analysisRate), "-f", "f32le", "pipe:1"], { signal: context.signal, keepStdout: true });
    check();
    if (decoded.code !== 0 || decoded.stdout.length < 4 * analysisRate) return { ok: false, reason: `The song could not be decoded. ${tail(decoded.stderr, 300)}`.trim() };
    const samples = new Float32Array(decoded.stdout.buffer.slice(decoded.stdout.byteOffset, decoded.stdout.byteOffset + decoded.stdout.length - (decoded.stdout.length % 4)));
    const duration = samples.length / analysisRate;
    report("preparing", percent(0, 0.04, 1), "Opened the song");

    // ---- analyse
    report("listening", 0.04, "Finding the beat");
    await new Promise((resolve) => setImmediate(resolve));
    const analysis = analyse(samples, analysisRate);
    check();
    if (analysis.bpm === null) warnings.push("There is no steady beat in this song to follow, so the picture moves with the sound instead.");
    report("listening", 0.12, analysis.bpm ? `Found the beat, ${Math.round(analysis.bpm)} beats a minute` : "Listened to the song");

    // ---- lyrics
    workDir = mkdtempSync(path.join(os.tmpdir(), "trhai-music-video-"));
    const needsListening = request.words !== "none" && whisperStatus().available;
    const lyricsEnd = needsListening ? 0.3 : 0.13;
    const lyrics = await findLyrics(request, analysis, duration, facts.duration, workDir, program, audioPath, context, (fraction, message) => report("lyrics", percent(0.12, lyricsEnd, fraction), message));
    check();
    warnings.push(...lyrics.warnings);

    // ---- the pictures ffmpeg is given
    report("drawing", lyricsEnd, "Getting ready to draw");
    const palette: Palette = choosePalette(request.palette, analysis);
    const track = visualTrack(samples, analysisRate, videoFps, analysis.beats);
    await new Promise((resolve) => setImmediate(resolve));
    check();
    const maps = radialMaps(geometry);
    writeFileSync(path.join(workDir, workFiles.xmap), maps.x);
    writeFileSync(path.join(workDir, workFiles.ymap), maps.y);
    writeFileSync(path.join(workDir, workFiles.disc), discMask(geometry));
    writeFileSync(path.join(workDir, workFiles.dust), dustLayer(geometry));

    let useCover = false;
    if (request.cover !== false && facts.streams.some((stream) => stream.attachedPicture)) {
      const extracted = await collect(program, extractCoverArgs(audioPath), { cwd: workDir, signal: context.signal });
      check();
      if (extracted.code === 0 && existsSync(path.join(workDir, workFiles.coverSource))) {
        writeFileSync(path.join(workDir, workFiles.circle), circleMask(geometry, coverRadius(geometry)));
        const made = await collect(program, coverArgs(geometry), { cwd: workDir, signal: context.signal });
        check();
        useCover = made.code === 0 && existsSync(path.join(workDir, workFiles.coverDisc)) && existsSync(path.join(workDir, workFiles.coverBackground));
        if (!useCover) warnings.push("The song's cover art could not be used, so the disc shows the title instead.");
      }
    }

    const font = process.platform === "win32" && !existsSync(path.join(env.WINDIR ?? "C:\\Windows", "Fonts", "bahnschrift.ttf")) ? "Segoe UI Semibold" : "Bahnschrift";
    writeFileSync(path.join(workDir, workFiles.captions), buildCaptions({ geometry, palette, cover: useCover, title, artist, duration, lines: lyrics.lines, font }), "utf8");

    // ---- draw
    const frames = Math.max(1, Math.ceil(duration * videoFps));
    const args = renderArgs({ geometry, palette, hue: hueExpression(analysis.sections), duration, cover: useCover, audio: audioPath, output: "video.mp4" });
    const started = Date.now();
    report("drawing", lyricsEnd, "Drawing the video");
    let lastReport = 0;
    const drawn = await runRender(program, args, workDir, track.levels, track.light, track.bands, frames, context.signal, (frame) => {
      const now = Date.now();
      if (now - lastReport < 400) return;
      lastReport = now;
      const fraction = Math.min(1, frame / frames);
      const elapsed = (now - started) / 1000;
      const remaining = fraction > 0.04 ? Math.round(elapsed / fraction - elapsed) : null;
      report("drawing", percent(lyricsEnd, 0.96, fraction), remaining !== null ? `Drawing the video, ${Math.round(fraction * 100)}% (about ${remaining < 90 ? `${remaining} seconds` : `${Math.round(remaining / 60)} minutes`} to go)` : `Drawing the video, ${Math.round(fraction * 100)}%`);
    });
    if (!drawn.ok) {
      if (drawn.cancelled) throw new Stop("Cancelled.", true);
      return { ok: false, reason: drawn.reason };
    }

    // ---- check it
    report("finishing", 0.96, "Checking the video");
    const made = path.join(workDir, "video.mp4");
    if (!existsSync(made) || statSync(made).size < 20_000) return { ok: false, reason: "ffmpeg finished but the video is missing or empty." };
    const after = await collect(program, ["-hide_banner", "-nostdin", "-i", made], { signal: context.signal });
    check();
    const problems = videoProblems(parseProbe(after.stderr), { seconds: duration, width: geometry.width, height: geometry.height });
    if (problems.length > 0) return { ok: false, reason: `The video that was made is not right: ${problems.join(", ")}.` };
    // The end of a file is what a cut-off render loses, so play the last stretch.
    const endCheck = await collect(program, ["-v", "error", "-nostdin", "-ss", Math.max(0, duration - 2.5).toFixed(2), "-i", made, "-f", "null", "-"], { signal: context.signal });
    check();
    if (endCheck.code !== 0 || endCheck.stderr.trim()) return { ok: false, reason: `The end of the video does not play: ${tail(endCheck.stderr, 300) || `code ${endCheck.code}`}` };

    const thumbnailAt = thumbnailTime(analysis, lyrics.lines);
    await collect(program, ["-y", "-v", "error", "-nostdin", "-ss", thumbnailAt.toFixed(2), "-i", made, "-frames:v", "1", "-q:v", "3", "thumbnail.jpg"], { cwd: workDir, signal: context.signal });
    check();

    // ---- put it in the workspace
    const folder = folderFor(request, title, preview);
    if (!folder) return { ok: false, reason: "There is nowhere in the workspace to put the video." };
    mkdirSync(folder.absolute, { recursive: true });
    copyFileSync(made, path.join(folder.absolute, "video.mp4"));
    if (existsSync(path.join(workDir, "thumbnail.jpg"))) copyFileSync(path.join(workDir, "thumbnail.jpg"), path.join(folder.absolute, "thumbnail.jpg"));
    else warnings.push("A thumbnail could not be made.");
    const extension = path.extname(audioPath).toLowerCase();
    const keptSong = path.join(folder.absolute, `song${extension}`);
    if (path.resolve(audioPath) !== path.resolve(keptSong)) copyFileSync(audioPath, keptSong);
    // An upload is kept only until a whole video has been made from it (a preview leaves it for the video to come).
    const uploads = resolveInWorkspace(uploadsFolder);
    if (!preview && uploads && path.dirname(path.resolve(audioPath)) === path.resolve(uploads)) rmSync(audioPath, { force: true });

    const savedAt = new Date().toISOString();
    writeFileSync(path.join(folder.absolute, "lyrics.json"), JSON.stringify({ source: lyrics.source, timing: lyrics.timing, lines: lyrics.lines.map((line) => ({ text: line.text, start: round(line.start), end: round(line.end) })) }, null, 2), "utf8");
    writeFileSync(path.join(folder.absolute, "info.json"), JSON.stringify({
      title, artist, seconds: round(duration), height, bpm: analysis.bpm, palette: palette.id, cover: useCover, preview, song: `song${extension}`, lyricsTiming: lyrics.timing, warnings, madeAt: savedAt
    }, null, 2), "utf8");

    const bytes = statSync(path.join(folder.absolute, "video.mp4")).size;
    report("finishing", 1, "Done");
    return {
      ok: true,
      result: {
        folder: folder.relative,
        video: `${folder.relative}/video.mp4`,
        thumbnail: `${folder.relative}/thumbnail.jpg`,
        title, artist, seconds: round(duration), height, bpm: analysis.bpm, palette: palette.id,
        lyricLines: lyrics.lines.length, lyricsTiming: lyrics.timing, cover: useCover, preview, warnings, bytes
      }
    };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, reason: error.reason, cancelled: error.cancelled };
    return { ok: false, reason: error instanceof Error ? error.message : "The video could not be made." };
  } finally {
    if (workDir) { try { rmSync(workDir, { recursive: true, force: true }); } catch { /* scratch space */ } }
  }
}

const round = (value: number) => Math.round(value * 100) / 100;
