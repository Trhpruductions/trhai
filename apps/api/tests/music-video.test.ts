import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { missingFrom, parseProbe, slugOf, thumbnailTime, titleFromFileName, videoProblems, type MediaFacts } from "../src/services/musicVideo.js";
import type { LyricLine } from "../src/services/lyricTiming.js";

// Real output of `ffmpeg -i`, kept as it was: a song with tags, the same with a cover, a finished video
// from an earlier version of this program (which tagged its colours wrongly), and a file that is no media.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("a song's length, tags and streams are read from what ffmpeg says about it", () => {
  const facts = parseProbe(fixture("ffmpeg-probe-mp3.txt"));
  assert.equal(facts.duration, 68);
  assert.deepEqual(facts.tags, { title: "Neon Highway", artist: "The Test Band", album: "Synthetic" });
  assert.deepEqual(facts.streams, [{ kind: "audio", codec: "mp3", width: undefined, height: undefined, pixelFormat: undefined, attachedPicture: false }]);
});

test("cover art is told apart from a picture, and a stream's own tags are not the song's", () => {
  const facts = parseProbe(fixture("ffmpeg-probe-mp3-cover.txt"));
  assert.deepEqual(facts.tags, { album: "Tests", title: "Neon Highway", artist: "The Test Band" }, "the cover's own title, 'Album cover', is not the song's");
  assert.equal(facts.streams.length, 2);
  assert.deepEqual(facts.streams[1], { kind: "video", codec: "png", width: 500, height: 500, pixelFormat: "rgba", attachedPicture: true });
});

test("a finished video's picture and sound are read, with how its colours are stored", () => {
  const facts = parseProbe(fixture("ffmpeg-probe-video.txt"));
  assert.equal(facts.duration, 68);
  assert.deepEqual(facts.streams.map((s) => [s.kind, s.codec]), [["video", "h264"], ["audio", "aac"]]);
  assert.deepEqual([facts.streams[0].width, facts.streams[0].height, facts.streams[0].pixelFormat], [1920, 1080, "yuvj420p"]);
});

test("what is not media, or is nothing, has no length and no streams", () => {
  assert.deepEqual(parseProbe(fixture("ffmpeg-probe-text.txt")), { duration: null, tags: {}, streams: [] });
  assert.deepEqual(parseProbe(""), { duration: null, tags: {}, streams: [] });
  const noLength = parseProbe("Input #0, wav, from 'x.wav':\n  Duration: N/A, bitrate: N/A\n  Stream #0:0: Audio: pcm_s16le, 44100 Hz, stereo, s16, 1411 kb/s\n");
  assert.equal(noLength.duration, null);
  assert.equal(noLength.streams.length, 1);
  assert.equal(parseProbe("Input #0, mp3, from 'x.mp3':\n  Duration: 01:02:03.50, start: 0.0\n").duration, 3723.5);
});

const good: MediaFacts = {
  duration: 68,
  tags: {},
  streams: [
    { kind: "video", codec: "h264", width: 1920, height: 1080, pixelFormat: "yuv420p", attachedPicture: false },
    { kind: "audio", codec: "aac", attachedPicture: false }
  ]
};
const wanted = { seconds: 68, width: 1920, height: 1080 };

test("a finished video is accepted when it is what was asked for", () => {
  assert.deepEqual(videoProblems(good, wanted), []);
  assert.deepEqual(videoProblems({ ...good, duration: 68.4 }, wanted), [], "a fraction of a second either way is nothing");
});

test("a video that is not right is not accepted, and the reason is given", () => {
  const say = (facts: MediaFacts) => videoProblems(facts, wanted).join("; ");
  assert.match(say({ ...good, duration: 41.2 }), /41\.2 seconds long, not 68\.0/);
  assert.match(say({ ...good, duration: null }), /does not say how long/);
  assert.match(say({ ...good, streams: [good.streams[1]] }), /no picture/);
  assert.match(say({ ...good, streams: [good.streams[0]] }), /no sound/);
  assert.match(say({ ...good, streams: [{ ...good.streams[0], attachedPicture: true }, good.streams[1]] }), /no picture/, "cover art is not the video");
  assert.match(say({ ...good, streams: [{ ...good.streams[0], codec: "mpeg4" }, good.streams[1]] }), /mpeg4, not h264/);
  assert.match(say({ ...good, streams: [{ ...good.streams[0], width: 1280, height: 720 }, good.streams[1]] }), /1280x720, not 1920x1080/);
  assert.match(say({ ...good, streams: [{ ...good.streams[0], pixelFormat: "yuvj420p" }, good.streams[1]] }), /stored as yuvj420p/);
  assert.match(say({ ...good, streams: [{ ...good.streams[0], pixelFormat: undefined }, good.streams[1]] }), /something unknown/);
  // What an earlier version made would now be refused.
  assert.match(videoProblems(parseProbe(fixture("ffmpeg-probe-video.txt")), wanted).join(), /yuvj420p/);
  assert.match(say({ duration: null, tags: {}, streams: [] }), /no picture.*no sound.*how long/);
});

test("a folder name comes from the title, in letters and numbers", () => {
  assert.equal(slugOf("Neon Highway"), "neon-highway");
  assert.equal(slugOf("  Café déjà vu!! "), "cafe-deja-vu");
  assert.equal(slugOf("A/B\\C"), "a-b-c");
  assert.equal(slugOf("♪♪♪"), "music-video");
  assert.equal(slugOf(""), "music-video");
  const long = slugOf("The Long And Winding Road To Nowhere In Particular And Beyond");
  assert.ok(long.length <= 48 && !long.endsWith("-"), long);
  assert.equal(slugOf("Track 5"), "track-5");
});

test("a title comes from the file's name when the file has none of its own", () => {
  assert.equal(titleFromFileName("C:/music/01 - neon_highway.mp3"), "neon highway");
  assert.equal(titleFromFileName("Track 5.mp3"), "Track 5");
  assert.equal(titleFromFileName("07. Something Else.wav"), "Something Else");
  assert.equal(titleFromFileName("My   Song.flac"), "My Song");
  assert.equal(titleFromFileName("___.mp3"), "Untitled");
  assert.equal(titleFromFileName("1999.mp3"), "1999", "a year is a title, not a track number");
});

const line = (start: number, end: number): LyricLine => ({ text: "x", start, end, words: [], confidence: 1 });
const loudness = (seconds: number, at: Record<number, number>) => Array.from({ length: Math.ceil(seconds * 4) }, (_, i) => at[Math.floor(i / 4)] ?? 0.2);

test("the thumbnail is the loudest moment in the middle of the song, in a line of lyrics if there are any", () => {
  // No lyrics: the loudest second between 15% and 85%.
  assert.equal(thumbnailTime({ duration: 100, intensity: loudness(100, { 3: 1, 50: 0.8, 52: 0.9, 95: 1 }) }, []), 52, "the loud start and end are not the song");
  // With lyrics: the loudest of the lines' middles.
  const lines = [line(20, 24), line(48, 52), line(60, 64)];
  assert.equal(thumbnailTime({ duration: 100, intensity: loudness(100, { 22: 0.5, 50: 0.6, 62: 0.9, 40: 1 }) }, lines), 62, "not the loudest second if no line is being sung in it");
  // Lines outside the middle are not candidates.
  assert.ok(Math.abs(thumbnailTime({ duration: 100, intensity: loudness(100, {}) }, [line(1, 4), line(96, 99)]) - 40) < 1e-9, "40% when nothing is eligible");
  // A very short song: 40% of the way in.
  assert.ok(Math.abs(thumbnailTime({ duration: 10, intensity: loudness(10, { 1: 1 }) }, []) - 4) < 1e-9);
  assert.ok(Number.isFinite(thumbnailTime({ duration: 100, intensity: [] }, [])), "no loudness readings is not an error");
});

// ---------------------------------------------------------------- what a build of ffmpeg can do

const needed = ["split", "crop", "scale", "format", "drawgrid", "movie", "loop", "fps", "remap", "gradients", "blend", "gblur", "colorchannelmixer", "hue", "vignette", "subtitles", "fade", "pad"];
const filtersText = (names: string[], twoColumns = true) => [
  "Filters:",
  "  T.. = Timeline support",
  "  .S. = Slice threading",
  "  A = Audio input/output",
  "  ------",
  ...names.map((name, i) => `${twoColumns ? [" TS", " ..", " .S"][i % 3] : [" TS.", " ...", " .S."][i % 3]} ${name.padEnd(18)} VV->V      Something it does.`)
].join("\n");
const filler = Array.from({ length: 60 }, (_, i) => `filler${i}`);
const encodersText = (names: string[]) => ["Encoders:", " V..... = Video", " A..... = Audio", " ------", ...names.map((name) => ` V....D ${name.padEnd(18)} An encoder`)].join("\n");
const encoders = ["libx264", "aac", "mpeg4", "png", "libx265", "libvpx", "flac", "mp3", "pcm_s16le"];

test("a build with everything a video needs is reported as lacking nothing, in either style of list", () => {
  assert.deepEqual(missingFrom(filtersText([...needed, ...filler]), encodersText(encoders)), []);
  assert.deepEqual(missingFrom(filtersText([...needed, ...filler], false), encodersText(encoders)), []);
});

test("what a build lacks is named, filter by filter and encoder by encoder", () => {
  assert.deepEqual(missingFrom(filtersText([...needed.filter((n) => n !== "subtitles"), ...filler]), encodersText(encoders)), ["the subtitles filter"]);
  assert.deepEqual(missingFrom(filtersText([...needed.filter((n) => n !== "remap" && n !== "hue"), ...filler]), encodersText(encoders)), ["the remap filter", "the hue filter"]);
  assert.deepEqual(missingFrom(filtersText([...needed, ...filler]), encodersText(encoders.filter((n) => n !== "libx264"))), ["the libx264 encoder"]);
});

test("a list that does not read as a list is not taken to mean that everything is missing", () => {
  assert.deepEqual(missingFrom("", ""), []);
  assert.deepEqual(missingFrom("Something else entirely", "No encoders here"), []);
  assert.deepEqual(missingFrom(filtersText(needed), encodersText(encoders)), [], "a list this short is a misreading, not a build with so few filters");
});

test("the real list's own header and lines are read as they are", () => {
  // The first lines of a real `ffmpeg -filters`, with its legend, and the filters a video needs added in its style.
  const real = fixture("ffmpeg-filters-excerpt.txt").replace(/\r?\n$/, "");
  const added = needed.map((name) => ` .. ${name.padEnd(16)} V->V       Something.`).join("\n");
  assert.deepEqual(missingFrom(`${real}\n${added}`, encodersText(encoders)), []);
  assert.equal(missingFrom(real, encodersText(encoders)).length, needed.length, "and without them, every one is found missing, so the real lines were counted");
});
