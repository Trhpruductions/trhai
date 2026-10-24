import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

// The screen and the assistant reach the music video maker through these routes, so they are tested as a
// caller would use them: over HTTP, with the maker itself stood in for - what is checked here is who may ask
// for a video, what they must send, and what they are told, not the drawing (music-video-render.test.ts).

const root = mkdtempSync(path.join(tmpdir(), "trhai-mv-routes-"));
const licenseDir = mkdtempSync(path.join(tmpdir(), "trhai-mv-license-"));
process.env.ASCEND_WORKSPACE = root;
process.env.TRHAI_LICENSE_FILE = path.join(licenseDir, "license.json");
process.env.TRHAI_TRIAL_MARKER = path.join(licenseDir, "elsewhere", "trial-started");
delete process.env.TRHAI_PAYWALL;

const { createApp } = await import("../src/server.js");
const { resetLicensingForTests, trialDays } = await import("../src/services/licensing.js");
const { writeProtectedJsonFile } = await import("../src/services/protectedJson.js");
const { resetMusicVideoJob, useMusicVideoRunner } = await import("../src/services/musicVideoJob.js");
type Outcome = import("../src/services/musicVideo.js").Outcome;
type MusicVideoRequest = import("../src/services/musicVideo.js").MusicVideoRequest;

const server = createApp().listen(0);
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.beforeEach(() => { resetLicensingForTests(); resetMusicVideoJob(); useMusicVideoRunner(); });
test.after(async () => {
  resetMusicVideoJob();
  useMusicVideoRunner();
  resetLicensingForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  rmSync(licenseDir, { recursive: true, force: true });
});

type Reply = { status: number; body: Record<string, any> };
async function send(method: string, route: string, body?: BodyInit, type?: string): Promise<Reply> {
  const response = await fetch(`${baseUrl}${route}`, { method, headers: type ? { "Content-Type": type } : {}, body });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
}
const getJson = (route: string) => send("GET", route);
const postJson = (route: string, payload: unknown) => send("POST", route, JSON.stringify(payload), "application/json");
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** A video that takes as long as the test says, stopped by the job's own signal. */
function slowVideo() {
  let finish: (outcome: Outcome) => void = () => {};
  const asked: MusicVideoRequest[] = [];
  const run = (request: MusicVideoRequest, context: { signal: AbortSignal }) => new Promise<Outcome>((resolve) => {
    asked.push(request);
    finish = resolve;
    context.signal.addEventListener("abort", () => resolve({ ok: false, reason: "Cancelled.", cancelled: true }));
  });
  return { run, asked, finish: (outcome: Outcome) => finish(outcome) };
}

test("what is ready, and how a video is getting on, can be asked for", async () => {
  const { status, body } = await getJson("/v1/music-video");
  assert.equal(status, 200);
  assert.deepEqual(body.data.job, { status: "idle" });
  assert.equal(typeof body.data.ready.ffmpeg, "boolean");
  assert.equal(typeof body.data.ready.listening, "boolean");
  assert.ok(body.data.ready.palettes.length >= 4);
  assert.ok(body.data.ready.extensions.includes(".mp3"));
  const library = await getJson("/v1/music-video/library");
  assert.equal(library.status, 200);
  assert.deepEqual(library.body.data, { videos: [] });
});

test("a song is uploaded as the body of the request, and only if it says it is audio", async () => {
  const wrongType = await send("POST", "/v1/music-video/audio?name=a.mp3", "not audio", "text/plain");
  assert.equal(wrongType.status, 415, "a page on another site cannot send this without asking first");
  const noType = await send("POST", "/v1/music-video/audio?name=a.mp3", Buffer.from("abc"));
  assert.equal(noType.status, 415);

  const saved = await send("POST", "/v1/music-video/audio?name=My%20Song.MP3", Buffer.alloc(5000, 1), "audio/mpeg");
  assert.equal(saved.status, 201);
  assert.match(saved.body.data.path, /^music-videos\/_uploads\/\d+-My Song\.mp3$/);
  assert.equal(saved.body.data.bytes, 5000);
  assert.ok(existsSync(path.join(root, saved.body.data.path)));
  assert.equal(readFileSync(path.join(root, saved.body.data.path)).length, 5000);

  const octet = await send("POST", "/v1/music-video/audio?name=b.wav", Buffer.alloc(100, 2), "application/octet-stream");
  assert.equal(octet.status, 201);
  const notSong = await send("POST", "/v1/music-video/audio?name=setup.exe", Buffer.alloc(100), "audio/mpeg");
  assert.equal(notSong.status, 415);
  assert.match(notSong.body.message, /not a song file/);
  const empty = await send("POST", "/v1/music-video/audio?name=c.mp3", Buffer.alloc(0), "audio/mpeg");
  assert.equal(empty.status, 400);
  const unnamed = await send("POST", "/v1/music-video/audio", Buffer.alloc(100, 3), "audio/mpeg");
  assert.equal(unnamed.status, 201, "a name is not required; it is a song.mp3");
});

test("a video is started with JSON, only one at a time, and can be stopped", async () => {
  const video = slowVideo();
  useMusicVideoRunner(video.run);

  assert.equal((await send("POST", "/v1/music-video", JSON.stringify({ audio: "a.mp3" }), "text/plain")).status, 415, "JSON only");
  const missing = await postJson("/v1/music-video", {});
  assert.equal(missing.status, 400);
  assert.match(missing.body.message, /audio is required/);
  assert.equal(missing.body.code, "INVALID_REQUEST");
  assert.equal((await postJson("/v1/music-video", { audio: "a.mp3", palette: "rainbow" })).status, 400);

  const started = await postJson("/v1/music-video", { audio: "a.mp3", title: "Neon Highway", height: 720, previewSeconds: 20, palette: "ember" });
  assert.equal(started.status, 202);
  assert.equal(typeof started.body.data.id, "string");
  assert.equal(started.body.data.job.status, "running");
  assert.equal(started.body.data.job.title, "Neon Highway");
  assert.equal(started.body.data.job.preview, true);
  assert.deepEqual(video.asked, [{ audio: "a.mp3", title: "Neon Highway", height: 720, previewSeconds: 20, palette: "ember" }], "what was asked for is what is made");

  const status = await getJson("/v1/music-video");
  assert.equal(status.body.data.job.status, "running");
  const second = await postJson("/v1/music-video", { audio: "b.mp3" });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "BUSY");
  assert.match(second.body.message, /Neon Highway/);

  assert.equal((await send("POST", "/v1/music-video/cancel", "{}", "text/plain")).status, 415);
  const cancelled = await postJson("/v1/music-video/cancel", {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.cancelled, true);
  await settled();
  assert.equal((await getJson("/v1/music-video")).body.data.job.status, "cancelled");
  assert.equal((await postJson("/v1/music-video/cancel", {})).body.data.cancelled, false, "nothing to stop now");
});

test("when it is done, the screen is told where the video is", async () => {
  const video = slowVideo();
  useMusicVideoRunner(video.run);
  await postJson("/v1/music-video", { audio: "a.mp3" });
  video.finish({ ok: true, result: { folder: "music-videos/x", video: "music-videos/x/video.mp4", thumbnail: "music-videos/x/thumbnail.jpg", title: "X", artist: "", seconds: 60, height: 720, bpm: 120, palette: "neon", lyricLines: 0, lyricsTiming: "none", cover: false, preview: false, warnings: ["a warning"], bytes: 9 } });
  await settled();
  const { body } = await getJson("/v1/music-video");
  assert.equal(body.data.job.status, "done");
  assert.equal(body.data.job.result.video, "music-videos/x/video.mp4");
  assert.deepEqual(body.data.job.result.warnings, ["a warning"]);
});

test("once the trial has ended, reading is open but making a video, or sending a song, is refused", async () => {
  writeProtectedJsonFile(process.env.TRHAI_LICENSE_FILE as string, { trialStartedAt: new Date(Date.now() - (trialDays + 1) * 24 * 60 * 60 * 1000).toISOString() });
  resetLicensingForTests();
  assert.equal((await getJson("/v1/music-video")).status, 200);
  assert.equal((await getJson("/v1/music-video/library")).status, 200);
  const start = await postJson("/v1/music-video", { audio: "a.mp3" });
  assert.equal(start.status, 402);
  assert.equal(start.body.code, "PAYMENT_REQUIRED");
  const before = uploadCount();
  assert.equal((await send("POST", "/v1/music-video/audio?name=a.mp3", Buffer.alloc(10), "audio/mpeg")).status, 402);
  assert.equal(uploadCount(), before, "and nothing was written");
});

function uploadCount(): number {
  try { return readdirSync(path.join(root, "music-videos", "_uploads")).length; } catch { return 0; }
}
