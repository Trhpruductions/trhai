// The music video that is being made, if one is: started, watched and stopped.
//
// A video takes minutes, so it runs in the background and whoever started it
// asks how it is getting on. One at a time: drawing a video uses every core, and
// two at once would each take twice as long and leave the PC unusable.
// The state lives in memory; what has been made is found again from its folder
// in the workspace (listMusicVideos in musicVideo.ts), so a restart loses only
// the news of a job that was running, and a job does not outlive the program.

import { randomUUID } from "node:crypto";
import { makeMusicVideo, type MusicVideoRequest, type MusicVideoResult, type Outcome, type Progress, type RunContext, type Stage } from "./musicVideo.js";

export type JobState =
  | { status: "idle" }
  | { status: "running"; id: string; title: string; preview: boolean; stage: Stage; fraction: number; message: string; startedAt: number; elapsedSeconds: number; cancelling: boolean }
  | { status: "done"; id: string; result: MusicVideoResult; finishedAt: number; elapsedSeconds: number }
  | { status: "failed"; id: string; reason: string; finishedAt: number }
  | { status: "cancelled"; id: string; finishedAt: number };

type Running = {
  id: string;
  title: string;
  preview: boolean;
  controller: AbortController;
  progress: Progress;
  startedAt: number;
  lastProgressAt: number;
  cancelling: boolean;
};

/** A job whose progress has not changed for this long is stuck, and is stopped. */
export const stallMilliseconds = 10 * 60_000;

let running: Running | null = null;
let finished: JobState = { status: "idle" };
let runner: (request: MusicVideoRequest, context: RunContext) => Promise<Outcome> = makeMusicVideo;

/** Test seam: what makes the video. Called with nothing, it puts the real one back. */
export function useMusicVideoRunner(next?: typeof runner): void {
  runner = next ?? makeMusicVideo;
}

/** Test seam: forget everything, as if the program had just started. */
export function resetMusicVideoJob(): void {
  running?.controller.abort();
  running = null;
  finished = { status: "idle" };
}

export function musicVideoStatus(now: number = Date.now()): JobState {
  if (!running) return finished;
  return {
    status: "running",
    id: running.id,
    title: running.title,
    preview: running.preview,
    stage: running.progress.stage,
    fraction: running.progress.fraction,
    message: running.cancelling ? "Stopping" : running.progress.message,
    startedAt: running.startedAt,
    elapsedSeconds: Math.round((now - running.startedAt) / 1000),
    cancelling: running.cancelling
  };
}

export type StartResult = { ok: true; id: string } | { ok: false; reason: string; busy?: boolean };

export function startMusicVideo(request: MusicVideoRequest, label?: string): StartResult {
  if (running) return { ok: false, busy: true, reason: `"${running.title}" is still being made. It can be stopped, or waited for.` };
  const controller = new AbortController();
  const now = Date.now();
  const job: Running = {
    id: randomUUID(),
    title: label?.trim() || request.title?.trim() || "your song",
    preview: typeof request.previewSeconds === "number" && request.previewSeconds > 0,
    controller,
    progress: { stage: "preparing", fraction: 0, message: "Starting" },
    startedAt: now,
    lastProgressAt: now,
    cancelling: false
  };
  running = job;

  // A render that goes quiet for ten minutes is not coming back; stop it rather than hold the one place for ever.
  let stalled = false;
  const watchdog = setInterval(() => {
    if (running === job && Date.now() - job.lastProgressAt > stallMilliseconds) {
      job.cancelling = true;
      job.controller.abort();
      stalled = true;
    }
  }, 15_000);
  watchdog.unref();

  const context: RunContext = {
    signal: controller.signal,
    report: (progress) => {
      job.progress = progress;
      if (progress.title) job.title = progress.title;
      job.lastProgressAt = Date.now();
    }
  };
  void runner(request, context).then(
    (outcome) => settle(job, outcome, stalled),
    (error: unknown) => settle(job, { ok: false, reason: error instanceof Error ? error.message : "The video could not be made." }, stalled)
  ).finally(() => clearInterval(watchdog));
  return { ok: true, id: job.id };
}

function settle(job: Running, outcome: Outcome, stalled: boolean): void {
  if (running !== job) return;
  const finishedAt = Date.now();
  running = null;
  if (outcome.ok) {
    finished = { status: "done", id: job.id, result: outcome.result, finishedAt, elapsedSeconds: Math.round((finishedAt - job.startedAt) / 1000) };
  } else if (outcome.cancelled && !stalled) {
    finished = { status: "cancelled", id: job.id, finishedAt };
  } else {
    finished = { status: "failed", id: job.id, reason: stalled ? "The video stopped making progress, so it was cancelled. Try again, and if it happens again, try the 720p size." : outcome.reason, finishedAt };
  }
}

/** Asks the running job to stop. It stops within a moment; the status says "cancelling" until then. */
export function cancelMusicVideo(): boolean {
  if (!running) return false;
  running.cancelling = true;
  running.controller.abort();
  return true;
}
