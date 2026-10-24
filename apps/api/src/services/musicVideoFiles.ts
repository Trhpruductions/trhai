// The files around a music video: the song as it is uploaded, the request that
// starts a video, what is ready on this PC, and the videos already made.
// musicVideo.ts makes them; this is what the screen and the assistant use to
// ask for one, and to find it again.

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ffmpegAvailable } from "./ffmpegPath.js";
import type { LyricsTiming } from "./lyricTiming.js";
import { audioExtensions, biggestAudioBytes, longestSongSeconds, musicVideosFolder, type MusicVideoRequest, uploadsFolder } from "./musicVideo.js";
import type { JobState } from "./musicVideoJob.js";
import { palettes } from "./musicVideoLook.js";
import { whisperStatus } from "./whisperTranscribe.js";
import { resolveInWorkspace, workspaceRelative } from "./workspace.js";

// ---------------------------------------------------------------- the request

const bounded = (value: unknown, limit: number): string | undefined | null => {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && value.length <= limit ? value : null;
};

/** A request as it arrives over the wire, checked, or why it is not one. */
export function parseMusicVideoRequest(body: unknown): { ok: true; request: MusicVideoRequest } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "Send the request as a JSON object." };
  const b = body as Record<string, unknown>;
  const audio = bounded(b.audio, 400);
  if (!audio) return { ok: false, message: "audio is required: the song's path in the workspace." };
  const title = bounded(b.title, 200);
  const artist = bounded(b.artist, 200);
  const lyrics = bounded(b.lyrics, 60_000);
  const folder = bounded(b.folder, 400);
  if (title === null) return { ok: false, message: "title must be text of up to 200 letters." };
  if (artist === null) return { ok: false, message: "artist must be text of up to 200 letters." };
  if (lyrics === null) return { ok: false, message: "lyrics must be text of up to 60,000 letters." };
  if (folder === null) return { ok: false, message: "folder must be a path in the workspace." };

  if (b.words !== undefined && b.words !== "auto" && b.words !== "none") return { ok: false, message: 'words must be "auto" or "none".' };
  const paletteId = b.palette;
  if (paletteId !== undefined && paletteId !== "auto" && !(typeof paletteId === "string" && palettes.some((palette) => palette.id === paletteId))) {
    return { ok: false, message: `palette must be "auto" or one of ${palettes.map((palette) => palette.id).join(", ")}.` };
  }
  const height = b.height === undefined ? undefined : Number(b.height);
  if (height !== undefined && height !== 720 && height !== 1080) return { ok: false, message: "height must be 720 or 1080." };
  if (b.cover !== undefined && typeof b.cover !== "boolean") return { ok: false, message: "cover must be true or false." };
  const preview = b.previewSeconds === undefined ? undefined : Number(b.previewSeconds);
  if (preview !== undefined && !(Number.isFinite(preview) && preview >= 3 && preview <= 60)) return { ok: false, message: "previewSeconds must be between 3 and 60." };

  return {
    ok: true,
    request: {
      audio,
      ...(title !== undefined ? { title } : {}),
      ...(artist !== undefined ? { artist } : {}),
      ...(lyrics !== undefined ? { lyrics } : {}),
      ...(b.words !== undefined ? { words: b.words as "auto" | "none" } : {}),
      ...(paletteId !== undefined && paletteId !== "auto" ? { palette: paletteId as string } : {}),
      ...(height !== undefined ? { height: height as 720 | 1080 } : {}),
      ...(b.cover !== undefined ? { cover: b.cover as boolean } : {}),
      ...(preview !== undefined ? { previewSeconds: preview } : {}),
      ...(folder !== undefined ? { folder } : {})
    }
  };
}

// ---------------------------------------------------------------- what is ready

/**
 * Why a video cannot be started, said at once, or null when it can. The video
 * is checked again as it starts; this is so that whoever asked is told in
 * the same breath, not by a job that fails a moment later.
 */
export function whyNotMusicVideo(request: MusicVideoRequest, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ffmpegAvailable(env)) return "ffmpeg is not installed, and music videos need it. Settings, Engine and models, installs it.";
  const audio = resolveInWorkspace(request.audio);
  if (!audio) return "That song is outside the workspace.";
  if (!audioExtensions.includes(path.extname(audio).toLowerCase())) return `That is not a song file this can read. It can read ${audioExtensions.join(", ")}.`;
  try {
    if (!statSync(audio).isFile()) return `There is no song at "${request.audio}" in the workspace.`;
  } catch {
    return `There is no song at "${request.audio}" in the workspace.`;
  }
  return null;
}

export type Readiness = {
  /** Without ffmpeg there is no video. */
  ffmpeg: boolean;
  /** Without whisper.cpp the words cannot be timed to the singing, and the lyrics are spread evenly. */
  listening: boolean;
  /** The look choices, each with the two colours of its bars as CSS colours, for a swatch. */
  palettes: Array<{ id: string; label: string; top: string; bottom: string }>;
  extensions: string[];
  longestSeconds: number;
};

const css = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;

export function musicVideoReadiness(env: NodeJS.ProcessEnv = process.env): Readiness {
  return {
    ffmpeg: ffmpegAvailable(env),
    listening: whisperStatus().available,
    palettes: palettes.map(({ id, label, barsTop, barsBottom }) => ({ id, label, top: css(barsTop), bottom: css(barsBottom) })),
    extensions: audioExtensions,
    longestSeconds: longestSongSeconds
  };
}

// ---------------------------------------------------------------- the song coming in

export type Upload = { ok: true; path: string; bytes: number } | { ok: false; status: 400 | 413 | 415 | 500; reason: string };

/** A file name that can be written anywhere: letters, numbers and a few marks, and no longer than a name needs to be. */
export function safeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/"));
  const extension = path.extname(base).toLowerCase();
  const stem = base.slice(0, base.length - extension.length).replace(/[^\p{L}\p{N} ._()'-]+/gu, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80);
  return `${stem || "song"}${extension}`;
}

const threeDays = 3 * 24 * 60 * 60 * 1000;

/** Songs uploaded and never used are cleared after three days. */
export function pruneUploads(now: number = Date.now()): void {
  const folder = resolveInWorkspace(uploadsFolder);
  if (!folder || !existsSync(folder)) return;
  for (const name of readdirSync(folder)) {
    try {
      const file = path.join(folder, name);
      if (now - statSync(file).mtimeMs > threeDays) rmSync(file, { force: true });
    } catch { /* gone already, or in use: left for next time */ }
  }
}

/** Writes an uploaded song to the workspace as it arrives, so that a big file is never held in memory. */
export async function saveUpload(source: Readable, name: string, announcedBytes?: number, limitBytes: number = biggestAudioBytes): Promise<Upload> {
  const safe = safeFileName(name);
  if (!audioExtensions.includes(path.extname(safe).toLowerCase())) return { ok: false, status: 415, reason: `That is not a song file this can read. It can read ${audioExtensions.join(", ")}.` };
  if (announcedBytes !== undefined && announcedBytes > limitBytes) return { ok: false, status: 413, reason: "That song file is too big." };
  const folder = resolveInWorkspace(uploadsFolder);
  if (!folder) return { ok: false, status: 500, reason: "There is nowhere in the workspace to put the song." };
  mkdirSync(folder, { recursive: true });
  pruneUploads();
  const file = path.join(folder, `${Date.now()}-${safe}`);

  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limitBytes) callback(new Error("too big"));
      else callback(null, chunk);
    }
  });
  try {
    await pipeline(source, limit, createWriteStream(file));
  } catch (error) {
    rmSync(file, { force: true });
    return error instanceof Error && error.message === "too big"
      ? { ok: false, status: 413, reason: "That song file is too big." }
      : { ok: false, status: 400, reason: "The song did not arrive in one piece." };
  }
  if (bytes === 0) {
    rmSync(file, { force: true });
    return { ok: false, status: 400, reason: "That file is empty." };
  }
  return { ok: true, path: workspaceRelative(file), bytes };
}

// ---------------------------------------------------------------- the videos already made

// A video's folder is read back by the library and by "make it again", so its facts are one place's to describe.
export type MusicVideoInfo = {
  title: string; artist: string; seconds: number; height: number; bpm: number | null; palette: string; cover: boolean; preview: boolean; song: string; lyricsTiming: LyricsTiming; warnings: string[]; madeAt: string;
};

export type LibraryEntry = MusicVideoInfo & { folder: string; video: string; thumbnail: string | null; lyrics: string; bytes: number };

/** Every music video in the workspace, newest first. */
export function listMusicVideos(): LibraryEntry[] {
  const root = resolveInWorkspace(musicVideosFolder);
  if (!root || !existsSync(root)) return [];
  const entries: LibraryEntry[] = [];
  for (const name of directoryNames(root)) {
    const folder = path.join(root, name);
    try {
      if (!statSync(folder).isDirectory() || !existsSync(path.join(folder, "video.mp4")) || !existsSync(path.join(folder, "info.json"))) continue;
      const info = JSON.parse(readFileSync(path.join(folder, "info.json"), "utf8")) as MusicVideoInfo;
      const lyrics = existsSync(path.join(folder, "lyrics.json"))
        ? (JSON.parse(readFileSync(path.join(folder, "lyrics.json"), "utf8")) as { lines?: Array<{ text?: string }> }).lines?.map((line) => String(line.text ?? "")).join("\n") ?? ""
        : "";
      entries.push({
        ...info,
        folder: workspaceRelative(folder),
        video: `${workspaceRelative(folder)}/video.mp4`,
        thumbnail: existsSync(path.join(folder, "thumbnail.jpg")) ? `${workspaceRelative(folder)}/thumbnail.jpg` : null,
        lyrics,
        bytes: statSync(path.join(folder, "video.mp4")).size
      });
    } catch { /* a folder that is not one of ours, or half written: not listed */ }
  }
  return entries.sort((a, b) => b.madeAt.localeCompare(a.madeAt));
}

function directoryNames(directory: string): string[] {
  try { return readdirSync(directory); } catch { return []; }
}

// ---------------------------------------------------------------- telling it in words

const clock = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const megabytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** How a music video is getting on, and what has been made, as the assistant tells it: what is true, and not one word of "done" for what is not. */
export function describeMusicVideos(job: JobState, recent: LibraryEntry[]): string {
  const lines: string[] = [];
  if (job.status === "running") {
    lines.push(`A music video is being made: "${job.title}"${job.preview ? " (a preview)" : ""}. ${job.message} - ${Math.round(job.fraction * 100)}% of the way, ${clock(job.elapsedSeconds)} so far. It is not finished yet.`);
  } else if (job.status === "done") {
    const r = job.result;
    lines.push(`The last music video finished: "${r.title}"${r.preview ? " (a preview)" : ""}, ${clock(r.seconds)} at ${r.height}p, ${megabytes(r.bytes)}, at ${r.video}.`);
    if (r.warnings.length > 0) lines.push(`Notes about it: ${r.warnings.join(" ")}`);
  } else if (job.status === "failed") {
    lines.push(`The last music video could not be made: ${job.reason}`);
  } else if (job.status === "cancelled") {
    lines.push("The last music video was stopped before it finished, and nothing was kept.");
  } else {
    lines.push("No music video is being made.");
  }
  lines.push(recent.length > 0
    ? `Made so far: ${recent.map((entry) => `"${entry.title}"${entry.preview ? " (preview)" : ""} (${clock(entry.seconds)}) at ${entry.video}`).join("; ")}.`
    : "None have been made yet.");
  return lines.join("\n");
}
