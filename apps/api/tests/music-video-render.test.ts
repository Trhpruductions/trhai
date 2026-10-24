import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// These make real videos with the real ffmpeg, so they run only where there is an ffmpeg with everything a
// music video needs (this PC after "Engine and models", or TRHAI_FFMPEG_PATH naming one). Where there is none
// they say so and are skipped, as the render itself would refuse. Whisper is kept out: TRH AI's listening is
// pointed at an empty folder, so nothing here depends on a model or runs one.

const root = mkdtempSync(path.join(tmpdir(), "trhai-mv-render-"));
const nothingToListenWith = mkdtempSync(path.join(tmpdir(), "trhai-mv-nowhisper-"));
process.env.ASCEND_WORKSPACE = root;
process.env.VEXORA_WHISPER_DIR = nothingToListenWith;

const { ffmpegAvailable, ffmpegProgram } = await import("../src/services/ffmpegPath.js");
const { makeMusicVideo, missingFromFfmpeg, parseProbe, videoProblems } = await import("../src/services/musicVideo.js");
type Progress = import("../src/services/musicVideo.js").Progress;

const program = ffmpegProgram();
const lacking = ffmpegAvailable() ? await missingFromFfmpeg(program, new AbortController().signal) : null;
const skip = lacking === null ? "there is no ffmpeg here" : lacking.length > 0 ? `this ffmpeg lacks ${lacking.join(" and ")}` : false;

test.after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(nothingToListenWith, { recursive: true, force: true });
});

mkdirSync(path.join(root, "songs"), { recursive: true });

/** A song to make a video of: a kick drum every half second (120 beats a minute) over a held note, `seconds` long. */
function makeSong(name: string, seconds: number, extra: string[] = []): string {
  const file = path.join(root, "songs", name);
  const run = spawnSync(program, [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `aevalsrc=0.8*sin(2*PI*(50+70*exp(-25*mod(t\\,0.5)))*t)*exp(-9*mod(t\\,0.5))+0.12*sin(2*PI*330*t)+0.05*sin(2*PI*1320*t)*exp(-30*mod(t\\,0.25)):s=44100:d=${seconds}`,
    "-ac", "2", ...extra, "-metadata", "title=Test Song", "-metadata", "artist=Test Band", file
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return `songs/${name}`;
}

const temporaryFolders = () => readdirSync(tmpdir()).filter((name) => name.startsWith("trhai-music-video-")).length;
const run = (request: Parameters<typeof makeMusicVideo>[0], options: { signal?: AbortSignal; seen?: Progress[]; onReport?: (progress: Progress) => void } = {}) =>
  makeMusicVideo({ height: 720, words: "none", ...request }, { signal: options.signal ?? new AbortController().signal, report: (p) => { options.seen?.push(p); options.onReport?.(p); } });
const probeFile = (relative: string) => parseProbe(spawnSync(program, ["-hide_banner", "-i", path.join(root, relative)], { encoding: "utf8" }).stderr);

test("a song becomes a video of the same length, with its sound, checked and saved with a thumbnail", { skip }, async () => {
  const song = makeSong("song-a.mp3", 6);
  const folders = temporaryFolders();
  const seen: Progress[] = [];
  const outcome = await run({ audio: song }, { seen });
  assert.ok(outcome.ok, JSON.stringify(outcome));
  if (!outcome.ok) return;
  const r = outcome.result;
  assert.equal(r.folder, "music-videos/test-song");
  assert.equal(r.video, "music-videos/test-song/video.mp4");
  assert.deepEqual([r.title, r.artist, r.height, r.preview, r.cover, r.lyricsTiming, r.lyricLines], ["Test Song", "Test Band", 720, false, false, "none", 0]);
  assert.ok(Math.abs(r.seconds - 6) < 0.2, `${r.seconds} s`);
  assert.ok(r.bpm !== null && Math.abs(r.bpm - 120) < 3, `${r.bpm} beats a minute`);
  assert.equal(r.palette, "neon");

  const facts = probeFile(r.video);
  assert.deepEqual(videoProblems(facts, { seconds: r.seconds, width: 1280, height: 720 }), []);
  assert.ok(existsSync(path.join(root, r.thumbnail)), "a thumbnail");
  assert.ok(r.bytes > 50_000 && r.bytes === readFileSync(path.join(root, r.video)).length);
  const info = JSON.parse(readFileSync(path.join(root, r.folder, "info.json"), "utf8"));
  assert.deepEqual([info.title, info.artist, info.palette, info.song, info.preview], ["Test Song", "Test Band", "neon", "song.mp3", false]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, r.folder, "lyrics.json"), "utf8")), { source: "none", timing: "none", lines: [] });
  assert.ok(existsSync(path.join(root, r.folder, "song.mp3")), "the song is kept beside its video, to make it again");

  // Progress goes forward, through the stages in order, and ends at one.
  const fractions = seen.map((p) => p.fraction);
  assert.deepEqual(fractions, [...fractions].sort((a, b) => a - b), "never goes back");
  assert.equal(fractions[fractions.length - 1], 1);
  const stages = [...new Set(seen.map((p) => p.stage))];
  assert.deepEqual(stages, ["preparing", "listening", "drawing", "finishing"], "no lyrics stage when no words are wanted");
  assert.equal(temporaryFolders(), folders, "the scratch folder is gone");
});

test("a preview is made over the same folder each time, while a video gets a folder of its own", { skip }, async () => {
  const song = makeSong("song-b.mp3", 5);
  const first = await run({ audio: song, previewSeconds: 3, title: "Same Title" });
  const second = await run({ audio: song, previewSeconds: 3, title: "Same Title" });
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.equal(first.result.folder, "music-videos/same-title-preview");
  assert.equal(second.result.folder, "music-videos/same-title-preview");
  assert.ok(Math.abs(first.result.seconds - 3) < 0.2 && first.result.preview);
  const one = await run({ audio: song, title: "Same Title" });
  const two = await run({ audio: song, title: "Same Title" });
  assert.ok(one.ok && two.ok);
  if (!one.ok || !two.ok) return;
  assert.deepEqual([one.result.folder, two.result.folder], ["music-videos/same-title", "music-videos/same-title-2"]);
  // Making it again, on purpose, replaces it.
  const again = await run({ audio: `${one.result.folder}/song.mp3`, title: "Same Title", folder: one.result.folder });
  assert.ok(again.ok);
  if (again.ok) assert.equal(again.result.folder, "music-videos/same-title");
});

test("pasted lyrics with nothing to listen with are spread over the song, shown, and said to be approximate", { skip }, async () => {
  const song = makeSong("song-c.mp3", 8);
  const outcome = await run({ audio: song, title: "Lyric Test", words: "auto", lyrics: "[Verse 1]\nWe are running down the highway\n\nNothing left to hold us back\nUnder skies of electric black\nTake my hand and we will fly" });
  assert.ok(outcome.ok, JSON.stringify(outcome));
  if (!outcome.ok) return;
  assert.equal(outcome.result.lyricsTiming, "approximate");
  assert.ok(outcome.result.lyricLines >= 3 && outcome.result.lyricLines <= 4, `${outcome.result.lyricLines} lines`);
  assert.match(outcome.result.warnings.join(" "), /spread evenly/);
  assert.match(outcome.result.warnings.join(" "), /Listening is installed/);
  const saved = JSON.parse(readFileSync(path.join(root, outcome.result.folder, "lyrics.json"), "utf8"));
  assert.equal(saved.source, "pasted");
  assert.equal(saved.lines[0].text, "We are running down the highway", "the heading line is not a lyric");
  assert.deepEqual(videoProblems(probeFile(outcome.result.video), { seconds: outcome.result.seconds, width: 1280, height: 720 }), []);
});

test("without lyrics pasted and nothing to listen with, there are none, and the reason is given", { skip }, async () => {
  const outcome = await run({ audio: makeSong("song-d.mp3", 4), title: "Quiet Words", words: "auto" });
  assert.ok(outcome.ok);
  if (outcome.ok) {
    assert.equal(outcome.result.lyricLines, 0);
    assert.match(outcome.result.warnings.join(" "), /There are no lyrics on the video/);
  }
});

test("the cover art in a song goes in the disc, unless it is asked not to", { skip }, async () => {
  const cover = path.join(root, "songs", "cover.png");
  const made = spawnSync(program, ["-y", "-v", "error", "-f", "lavfi", "-i", "gradients=s=400x400:c0=0xff8800:c1=0x0044ff:seed=4:d=1", "-frames:v", "1", cover], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const withArt = path.join(root, "songs", "song-e.mp3");
  const plain = path.join(root, "songs", "song-e-plain.mp3");
  makeSong("song-e-plain.mp3", 4);
  const mux = spawnSync(program, ["-y", "-v", "error", "-i", plain, "-i", cover, "-map", "0:a", "-map", "1:v", "-c", "copy", "-id3v2_version", "3", withArt], { encoding: "utf8" });
  assert.equal(mux.status, 0, mux.stderr);
  const shown = await run({ audio: "songs/song-e.mp3", title: "With Art" });
  assert.ok(shown.ok, JSON.stringify(shown));
  if (shown.ok) {
    assert.equal(shown.result.cover, true);
    assert.deepEqual(videoProblems(probeFile(shown.result.video), { seconds: shown.result.seconds, width: 1280, height: 720 }), []);
  }
  const off = await run({ audio: "songs/song-e.mp3", title: "Without Art", cover: false });
  assert.ok(off.ok);
  if (off.ok) assert.equal(off.result.cover, false);
  const none = await run({ audio: "songs/song-e-plain.mp3", title: "No Art Here" });
  assert.ok(none.ok);
  if (none.ok) assert.equal(none.result.cover, false, "a song with no art has none to show");
});

test("an upload is cleared once a whole video is made from it, but kept after a preview", { skip }, async () => {
  const uploads = path.join(root, "music-videos", "_uploads");
  mkdirSync(uploads, { recursive: true });
  const source = path.join(root, makeSong("song-f.mp3", 4));
  const upload = path.join(uploads, "1-upload.mp3");
  copyFileSync(source, upload);
  const preview = await run({ audio: "music-videos/_uploads/1-upload.mp3", previewSeconds: 3, title: "Uploaded" });
  assert.ok(preview.ok);
  assert.ok(existsSync(upload), "kept: the video itself is still to be made");
  const whole = await run({ audio: "music-videos/_uploads/1-upload.mp3", title: "Uploaded" });
  assert.ok(whole.ok);
  assert.equal(existsSync(upload), false, "cleared: the song is beside its video now");
  assert.ok(existsSync(path.join(root, "music-videos", "uploaded", "song.mp3")));
});

test("stopping a video stops the drawing, and leaves no folder and no scratch files", { skip }, async () => {
  const song = makeSong("song-g.mp3", 12);
  const folders = temporaryFolders();
  const controller = new AbortController();
  const seen: Progress[] = [];
  const outcome = await run({ audio: song, title: "Stopped Midway" }, {
    signal: controller.signal,
    seen,
    // Once the frames are really being drawn, not just about to be.
    onReport: (p) => { if (p.stage === "drawing" && p.message.startsWith("Drawing the video, ")) controller.abort(); }
  });
  assert.deepEqual(outcome.ok ? null : [outcome.cancelled, outcome.reason], [true, "Cancelled."]);
  assert.equal(existsSync(path.join(root, "music-videos", "stopped-midway")), false, "nothing half-made is kept");
  assert.equal(temporaryFolders(), folders);
  // It had begun drawing, and had not finished.
  assert.ok(seen.some((p) => p.stage === "drawing"));
  assert.ok(seen.every((p) => p.fraction < 1));
});

test("what cannot be made into a video is refused at once, in words", { skip }, async () => {
  const folders = temporaryFolders();
  const refusal = async (request: Parameters<typeof run>[0]) => {
    const outcome = await run(request);
    assert.equal(outcome.ok, false, JSON.stringify(request));
    return outcome.ok ? "" : outcome.reason;
  };
  assert.match(await refusal({ audio: "songs/not-there.mp3" }), /song file is not there/);
  assert.match(await refusal({ audio: "../outside.mp3" }), /outside the workspace/);
  assert.match(await refusal({ audio: "songs/readme.txt" }), /not a song file this can read/);
  writeFileSync(path.join(root, "songs", "fake.mp3"), "this is not audio at all, only words");
  assert.match(await refusal({ audio: "songs/fake.mp3" }), /could not be read as a song/);
  assert.match(await refusal({ audio: makeSong("tiny.mp3", 2) }), /too short/);
  assert.equal(existsSync(path.join(root, "music-videos", "test-song-2")), false);
  assert.equal(temporaryFolders(), folders, "and nothing was started that needed clearing");
});
