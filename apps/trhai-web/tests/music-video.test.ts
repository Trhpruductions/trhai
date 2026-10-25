import test from "node:test";
import assert from "node:assert/strict";
import {
  formatClock, formatSize, guessTitle, hasExtension, lyricsNote, previewSeconds, remainingText, requestFrom, stageWords, whyNot, type Ready
} from "../src/lib/musicVideo.js";

// What the music video screen works out for itself: the words it says, and whether a video can be started.

const ready = (overrides: Partial<Ready> = {}): Ready => ({
  ffmpeg: true, listening: true, palettes: [{ id: "neon", label: "Neon", top: "#4de8ff", bottom: "#ff2fa8" }], extensions: [".mp3", ".wav", ".m4a"], longestSeconds: 900, ...overrides
});

test("a title is made from a song's file name, the way the service makes it", () => {
  assert.equal(guessTitle("neon_highway.mp3"), "neon highway");
  assert.equal(guessTitle("01 - Neon Highway.mp3"), "Neon Highway");
  assert.equal(guessTitle("C:\\Music\\07. Something Else.wav"), "Something Else");
  assert.equal(guessTitle("Music/Track 5.m4a"), "Track 5");
  assert.equal(guessTitle("1999.mp3"), "1999", "a year is a title, not a track number");
  assert.equal(guessTitle("___.mp3"), "Untitled");
  assert.equal(guessTitle("no extension"), "no extension");
});

test("a length is shown as a clock, and a size in the unit that suits it", () => {
  assert.equal(formatClock(187), "3:07");
  assert.equal(formatClock(59.6), "1:00");
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatClock(-5), "0:00");
  assert.equal(formatSize(900), "1 KB");
  assert.equal(formatSize(1_500_000), "1 MB");
  assert.equal(formatSize(43_451_268), "41 MB");
  assert.equal(formatSize(3 * 1024 ** 3), "3.0 GB");
});

test("the time left is told only once it can be told, and in steps no finer than they can be trusted", () => {
  assert.equal(remainingText(3, 0.5), null, "too early");
  assert.equal(remainingText(60, 0.05), null, "too little done");
  assert.equal(remainingText(100, 0.5), "about 2 minutes left");
  assert.equal(remainingText(60, 0.5), "about 60 seconds left");
  assert.equal(remainingText(40, 0.5), "about 40 seconds left");
  assert.equal(remainingText(100, 0.97), "a few seconds left");
  assert.equal(remainingText(90, 0.5), "about 2 minutes left", "ninety seconds is where it turns to minutes");
  assert.equal(remainingText(60, 0.25), "about 3 minutes left");
  assert.equal(remainingText(60, 0.14), "about 6 minutes left");
});

test("the lyrics box says what will happen with what is in it", () => {
  assert.match(lyricsNote(ready(), true, false), /listen to the song and light each word/);
  assert.match(lyricsNote(ready({ listening: false }), true, false), /spread evenly/);
  assert.match(lyricsNote(ready({ listening: false }), true, false), /Install Listening/);
  assert.match(lyricsNote(ready(), false, false), /listen for the words/);
  assert.match(lyricsNote(ready({ listening: false }), false, false), /no words/);
  assert.equal(lyricsNote(ready(), true, true), "No words will be put on the video.");
  assert.equal(lyricsNote(ready(), false, true), "No words will be put on the video.");
});

test("a video can be started only when nothing is in the way, and the one thing in the way is named", () => {
  const free = { uploading: false, song: true, busy: false };
  assert.equal(whyNot(ready(), free), null);
  assert.match(whyNot(null, free) ?? "", /Checking/);
  assert.match(whyNot(ready({ ffmpeg: false }), free) ?? "", /ffmpeg/);
  assert.match(whyNot(ready(), { ...free, busy: true }) ?? "", /being made/);
  assert.match(whyNot(ready(), { ...free, uploading: true }) ?? "", /still being loaded/);
  assert.match(whyNot(ready(), { ...free, song: false }) ?? "", /Choose a song/);
  assert.match(whyNot(ready({ ffmpeg: false }), { ...free, song: false }) ?? "", /ffmpeg/, "the thing that cannot be fixed by the person at the form comes first");
});

test("a file is told to be a song by its ending", () => {
  assert.equal(hasExtension("Song.MP3", [".mp3"]), true);
  assert.equal(hasExtension("song.mp3.exe", [".mp3"]), false);
  assert.equal(hasExtension("mp3", [".mp3"]), false);
  assert.equal(hasExtension("", [".mp3"]), false);
});

const form = { audio: "music-videos/_uploads/1-a.mp3", title: "", artist: "", lyrics: "", noWords: false, palette: "auto", height: 1080 as const, cover: true, preview: false, replace: null };

test("the form becomes a request, leaving out what was left empty so that the song's own details are used", () => {
  assert.deepEqual(requestFrom(form), { audio: "music-videos/_uploads/1-a.mp3", height: 1080, cover: true });
  assert.deepEqual(
    requestFrom({ ...form, title: "  Neon Highway ", artist: " The Band", lyrics: "one\ntwo\n", palette: "ember", height: 720, cover: false }),
    { audio: "music-videos/_uploads/1-a.mp3", title: "Neon Highway", artist: "The Band", lyrics: "one\ntwo\n", palette: "ember", height: 720, cover: false },
    "the lyrics are sent as they were typed"
  );
  assert.deepEqual(requestFrom({ ...form, lyrics: "   \n  " }), { audio: form.audio, height: 1080, cover: true }, "a box of spaces is empty");
});

test("no words wins over lyrics that are still in the box, and a preview is a short one that replaces nothing", () => {
  assert.deepEqual(requestFrom({ ...form, lyrics: "one", noWords: true }), { audio: form.audio, words: "none", height: 1080, cover: true });
  assert.deepEqual(requestFrom({ ...form, preview: true, replace: "music-videos/x" }), { audio: form.audio, height: 1080, cover: true, previewSeconds });
  assert.deepEqual(requestFrom({ ...form, replace: "music-videos/x" }), { audio: form.audio, height: 1080, cover: true, folder: "music-videos/x" });
  assert.equal(previewSeconds >= 10 && previewSeconds <= 30, true);
});

test("every stage of making a video has words", () => {
  assert.deepEqual(Object.keys(stageWords).sort(), ["drawing", "finishing", "listening", "lyrics", "preparing"]);
  for (const words of Object.values(stageWords)) assert.ok(words.length > 3);
});
