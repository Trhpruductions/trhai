import test, { mock } from "node:test";
import assert from "node:assert/strict";
import type { MusicVideoRequest, MusicVideoResult, Outcome, RunContext } from "../src/services/musicVideo.js";
import { cancelMusicVideo, musicVideoStatus, resetMusicVideoJob, startMusicVideo, stallMilliseconds, useMusicVideoRunner } from "../src/services/musicVideoJob.js";

const result: MusicVideoResult = {
  folder: "music-videos/x", video: "music-videos/x/video.mp4", thumbnail: "music-videos/x/thumbnail.jpg", title: "X", artist: "", seconds: 60, height: 720, bpm: 120, palette: "neon",
  lyricLines: 0, lyricsTiming: "none", cover: false, preview: false, warnings: [], bytes: 1000
};

/** A video that takes as long as the test says: finished by hand, or stopped by the job's own signal. */
function slowVideo() {
  let finish: (outcome: Outcome) => void = () => {};
  let seen: RunContext | undefined;
  let request: MusicVideoRequest | undefined;
  const run = (asked: MusicVideoRequest, context: RunContext) => new Promise<Outcome>((resolve) => {
    request = asked;
    seen = context;
    finish = resolve;
    context.signal.addEventListener("abort", () => resolve({ ok: false, reason: "Cancelled.", cancelled: true }));
  });
  return { run, finish: (outcome: Outcome) => finish(outcome), context: () => seen as RunContext, request: () => request as MusicVideoRequest };
}
const settled = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => { resetMusicVideoJob(); useMusicVideoRunner(); });
test.afterEach(() => { resetMusicVideoJob(); useMusicVideoRunner(); mock.timers.reset(); });

test("with nothing started, nothing is running", () => {
  assert.deepEqual(musicVideoStatus(), { status: "idle" });
  assert.equal(cancelMusicVideo(), false);
});

test("a video that is being made reports how far it has got, as it says so", async () => {
  const video = slowVideo();
  useMusicVideoRunner(video.run);
  const started = startMusicVideo({ audio: "a.mp3", title: "Neon Highway" });
  assert.ok(started.ok);
  const first = musicVideoStatus();
  assert.equal(first.status, "running");
  if (first.status !== "running") return;
  assert.deepEqual([first.title, first.preview, first.stage, first.fraction, first.cancelling], ["Neon Highway", false, "preparing", 0, false]);
  assert.equal(first.id, started.ok ? started.id : "");

  video.context().report({ stage: "drawing", fraction: 0.5, message: "Drawing the video, 40%" });
  const next = musicVideoStatus(first.startedAt + 83_400);
  assert.equal(next.status, "running");
  if (next.status === "running") assert.deepEqual([next.stage, next.fraction, next.message, next.elapsedSeconds], ["drawing", 0.5, "Drawing the video, 40%", 83]);
  assert.deepEqual(video.request(), { audio: "a.mp3", title: "Neon Highway" }, "the request is passed on as it was");

  video.finish({ ok: true, result });
  await settled();
  const done = musicVideoStatus();
  assert.equal(done.status, "done");
  if (done.status === "done") assert.deepEqual(done.result, result);
});

test("a video's title is the one it turns out to have, once the song has been opened", async () => {
  const video = slowVideo();
  useMusicVideoRunner(video.run);
  startMusicVideo({ audio: "a.mp3" });
  const before = musicVideoStatus();
  assert.equal(before.status === "running" && before.title, "your song");
  video.context().report({ stage: "preparing", fraction: 0.04, message: "Opened the song", title: "Neon Highway" });
  const after = musicVideoStatus();
  assert.equal(after.status === "running" && after.title, "Neon Highway");
  video.context().report({ stage: "drawing", fraction: 0.5, message: "Drawing" });
  const later = musicVideoStatus();
  assert.equal(later.status === "running" && later.title, "Neon Highway", "kept when later reports do not repeat it");
});

test("only one video is made at a time", async () => {
  const video = slowVideo();
  useMusicVideoRunner(video.run);
  assert.ok(startMusicVideo({ audio: "a.mp3", title: "First" }).ok);
  const second = startMusicVideo({ audio: "b.mp3", title: "Second" });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.busy, true);
    assert.match(second.reason, /"First" is still being made/);
  }
  video.finish({ ok: true, result });
  await settled();
  assert.ok(startMusicVideo({ audio: "b.mp3" }).ok, "free again once it is done");
});

test("a video can be stopped, and says so while it stops and after", async () => {
  const video = slowVideo();
  useMusicVideoRunner(video.run);
  startMusicVideo({ audio: "a.mp3" });
  assert.equal(cancelMusicVideo(), true);
  const stopping = musicVideoStatus();
  assert.equal(stopping.status, "running");
  if (stopping.status === "running") assert.deepEqual([stopping.cancelling, stopping.message], [true, "Stopping"]);
  await settled();
  assert.equal(musicVideoStatus().status, "cancelled");
  assert.equal(cancelMusicVideo(), false, "nothing left to stop");
});

test("a video that fails says why, whether it reports it or throws", async () => {
  useMusicVideoRunner(async () => ({ ok: false, reason: "ffmpeg stopped while drawing the video (code 1)." }));
  startMusicVideo({ audio: "a.mp3" });
  await settled();
  let status = musicVideoStatus();
  assert.equal(status.status, "failed");
  if (status.status === "failed") assert.match(status.reason, /ffmpeg stopped/);

  useMusicVideoRunner(async () => { throw new Error("the disk is full"); });
  startMusicVideo({ audio: "a.mp3" });
  await settled();
  status = musicVideoStatus();
  assert.equal(status.status, "failed");
  if (status.status === "failed") assert.equal(status.reason, "the disk is full");

  useMusicVideoRunner(async () => { throw "not an error object"; });
  startMusicVideo({ audio: "a.mp3" });
  await settled();
  status = musicVideoStatus();
  assert.equal(status.status === "failed" && status.reason, "The video could not be made.");
});

test("the title shown is the one given, the request's, or a plain default, and a preview says it is one", async () => {
  const video = slowVideo();
  useMusicVideoRunner(video.run);
  startMusicVideo({ audio: "a.mp3", previewSeconds: 20 }, "  A Label  ");
  let status = musicVideoStatus();
  assert.deepEqual(status.status === "running" && [status.title, status.preview], ["A Label", true]);
  video.finish({ ok: true, result });
  await settled();
  startMusicVideo({ audio: "a.mp3" });
  status = musicVideoStatus();
  assert.deepEqual(status.status === "running" && [status.title, status.preview], ["your song", false]);
});

test("a video that goes quiet for ten minutes is stopped, but one that keeps reporting is not", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const video = slowVideo();
  useMusicVideoRunner(video.run);
  startMusicVideo({ audio: "a.mp3" });

  mock.timers.tick(stallMilliseconds - 60_000);
  video.context().report({ stage: "drawing", fraction: 0.3, message: "Drawing" });
  mock.timers.tick(stallMilliseconds - 60_000);
  await settled();
  assert.equal(musicVideoStatus().status, "running", "a report in between starts the ten minutes again");

  mock.timers.tick(120_000);
  await settled();
  const status = musicVideoStatus();
  assert.equal(status.status, "failed");
  if (status.status === "failed") assert.match(status.reason, /stopped making progress/);
});

test("a video that is forgotten while it runs cannot change what is shown afterwards", async () => {
  const video = slowVideo();
  useMusicVideoRunner(video.run);
  startMusicVideo({ audio: "a.mp3" });
  resetMusicVideoJob();
  video.finish({ ok: true, result });
  await settled();
  assert.deepEqual(musicVideoStatus(), { status: "idle" });
});
