// The music video maker, as the screen sees it: what the API reports, and the
// small decisions the screen makes from it - what to say while a video is being
// drawn, whether a video can be started, how long is left. Kept apart from the
// screen so they can be tested without one.

import { apiBaseUrl, apiFetch, apiGet, apiPost, requestHeaders, type ApiResult } from "./api";

export type Palette = { id: string; label: string; top: string; bottom: string };

export type Ready = {
  ffmpeg: boolean;
  /** Whether TRH AI can listen to a song, to time lyrics to the singing. */
  listening: boolean;
  palettes: Palette[];
  extensions: string[];
  longestSeconds: number;
};

export type Stage = "preparing" | "listening" | "lyrics" | "drawing" | "finishing";

export type Result = {
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
  lyricsTiming: "none" | "heard" | "approximate";
  cover: boolean;
  preview: boolean;
  warnings: string[];
  bytes: number;
};

export type Job =
  | { status: "idle" }
  | { status: "running"; id: string; title: string; preview: boolean; stage: Stage; fraction: number; message: string; startedAt: number; elapsedSeconds: number; cancelling: boolean }
  | { status: "done"; id: string; result: Result; finishedAt: number; elapsedSeconds: number }
  | { status: "failed"; id: string; reason: string; finishedAt: number }
  | { status: "cancelled"; id: string; finishedAt: number };

export type Status = { job: Job; ready: Ready };

export type LibraryEntry = {
  folder: string;
  video: string;
  thumbnail: string | null;
  title: string;
  artist: string;
  seconds: number;
  height: number;
  bpm: number | null;
  palette: string;
  cover: boolean;
  preview: boolean;
  /** The song's file name inside the folder, kept so that the video can be made again. */
  song: string;
  lyricsTiming: "none" | "heard" | "approximate";
  /** The lyrics shown, a line each. */
  lyrics: string;
  warnings: string[];
  madeAt: string;
  bytes: number;
};

/** The longest preview worth making: enough to see the look and a line or two of lyrics. */
export const previewSeconds = 20;

export const stageWords: Record<Stage, string> = {
  preparing: "Opening the song",
  listening: "Finding the beat",
  lyrics: "Listening to the words",
  drawing: "Drawing the video",
  finishing: "Checking it"
};

/** A title from a file name: "01 - neon_highway.mp3" is "neon highway". Matches what the API does when the song has no title of its own. */
export function guessTitle(fileName: string): string {
  const name = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  const tidy = name.replace(/_+/g, " ").replace(/^\s*\d{1,3}\s*[-.)]\s*/, "").replace(/\s+/g, " ").trim();
  return tidy || "Untitled";
}

/** 187 seconds as "3:07". */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const secs = total % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * How long is left, once enough has been done to tell: from how long it has taken
 * and how far it has got. Nothing before then - a guess made in the first
 * seconds is wrong by minutes, and a wrong number is worse than none.
 */
export function remainingText(elapsedSeconds: number, fraction: number): string | null {
  if (fraction < 0.1 || elapsedSeconds < 8) return null;
  const left = Math.round(elapsedSeconds / fraction - elapsedSeconds);
  if (left < 10) return "a few seconds left";
  if (left < 90) return `about ${Math.round(left / 5) * 5} seconds left`;
  const minutes = Math.round(left / 60);
  return `about ${minutes} minute${minutes === 1 ? "" : "s"} left`;
}

/** What to tell someone about the lyrics box, from what this PC can do and what they have chosen. */
export function lyricsNote(ready: Pick<Ready, "listening">, hasLyrics: boolean, noWords: boolean): string {
  if (noWords) return "No words will be put on the video.";
  if (hasLyrics) {
    return ready.listening
      ? "TRH AI will listen to the song and light each word as it is sung."
      : "Listening is not installed, so these lines will be spread evenly over the song. Install Listening (Settings, Engine and models) to have them follow the singing.";
  }
  return ready.listening
    ? "Leave this empty and TRH AI will listen for the words. Singing over a band is hard to hear, so pasting the real lyrics is better."
    : "Paste the lyrics to put them on the video. Without them there will be no words: TRH AI cannot listen to the song until Listening is installed (Settings, Engine and models).";
}

export type Form = { uploading: boolean; song: boolean; busy: boolean };

/** Whether a video can be started now, or the one thing that is in the way. */
export function whyNot(ready: Ready | null, form: Form): string | null {
  if (!ready) return "Checking this PC.";
  if (!ready.ffmpeg) return "Music videos need ffmpeg. Install it in Settings, Engine and models.";
  if (form.busy) return "A video is being made. It can be stopped, or waited for.";
  if (form.uploading) return "The song is still being loaded.";
  if (!form.song) return "Choose a song first.";
  return null;
}

export function hasExtension(fileName: string, extensions: string[]): boolean {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 && extensions.includes(fileName.slice(dot).toLowerCase());
}

/** The address a finished video, or its thumbnail, is played from. */
export const mediaUrl = (path: string) => `${apiBaseUrl}/v1/files/raw?path=${encodeURIComponent(path)}`;

export type VideoRequest = {
  audio: string;
  title?: string;
  artist?: string;
  lyrics?: string;
  words?: "none";
  palette?: string;
  height: 720 | 1080;
  cover: boolean;
  previewSeconds?: number;
  folder?: string;
};

/** What the form says, as the request the API takes: empty boxes are left out, so the song's own tags and the song's own look are used. */
export function requestFrom(form: {
  audio: string; title: string; artist: string; lyrics: string; noWords: boolean; palette: string; height: 720 | 1080; cover: boolean; preview: boolean; replace: string | null;
}): VideoRequest {
  const title = form.title.trim();
  const artist = form.artist.trim();
  const lyrics = form.lyrics.trim();
  return {
    audio: form.audio,
    ...(title ? { title } : {}),
    ...(artist ? { artist } : {}),
    ...(form.noWords ? { words: "none" as const } : lyrics ? { lyrics: form.lyrics } : {}),
    ...(form.palette !== "auto" ? { palette: form.palette } : {}),
    height: form.height,
    cover: form.cover,
    ...(form.preview ? { previewSeconds } : {}),
    ...(form.replace && !form.preview ? { folder: form.replace } : {})
  };
}

export const getStatus = () => apiGet<Status>("/v1/music-video");
export const getLibrary = () => apiGet<{ videos: LibraryEntry[] }>("/v1/music-video/library");
export const startVideo = (request: VideoRequest) => apiPost<{ id: string; job: Job }>("/v1/music-video", request);
export const stopVideo = () => apiPost<{ cancelled: boolean; job: Job }>("/v1/music-video/cancel", {});

/** Sends the song to the API as it is, to be written into the workspace. */
export async function uploadSong(file: File): Promise<ApiResult<{ path: string; bytes: number }>> {
  try {
    const response = await apiFetch(`${apiBaseUrl}/v1/music-video/audio?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: requestHeaders({ "Content-Type": file.type.startsWith("audio/") ? file.type : "application/octet-stream" }),
      body: file
    });
    const payload = await response.json().catch(() => null) as { data?: { path: string; bytes: number }; message?: string } | null;
    if (!response.ok || !payload?.data) return { ok: false, reason: payload?.message ?? `The service answered with ${response.status}.` };
    return { ok: true, data: payload.data };
  } catch {
    return { ok: false, reason: "Could not reach the local service." };
  }
}
