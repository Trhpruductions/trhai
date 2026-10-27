import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Converting audio and video: what is asked for is understood, ffmpeg is told exactly the right things, what it makes
// is read back before anyone is told it is there, and everything that cannot be done is said in words with nothing left
// behind. The first half runs with a stand-in for ffmpeg, so every way it can go wrong is tried; the second makes real
// files with the real ffmpeg, wherever there is one.

const {
  clockText, convertMedia, describeMadeMedia, ffmpegArgs, mediaFormatList, mediaFormats, parseClock, parseMediaFormat, parseProbe,
  parseQuality, planTrim
} = await import("../src/services/mediaConverter.js");
const { ffmpegAvailable, ffmpegProgram } = await import("../src/services/ffmpegPath.js");
type RunFfmpeg = import("../src/services/mediaConverter.js").RunFfmpeg;
type MediaFormat = import("../src/services/mediaConverter.js").MediaFormat;

const root = mkdtempSync(path.join(tmpdir(), "trhai-media-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function folder(): string {
  counter += 1;
  const dir = path.join(root, `case-${counter}`);
  return path.join(dir);
}

// ------------------------------------------------------------------------ what is asked for

test("a format is understood however it is written, and one that cannot be made says what can", () => {
  for (const [given, expected] of [["mp3", "mp3"], [".MP3", "mp3"], [" Wav ", "wav"], ["wave", "wav"], ["aac", "m4a"], ["M4A", "m4a"], ["vorbis", "ogg"], ["mpeg4", "mp4"], ["mp3 audio", "mp3"], ["flac,", "flac"]] as const) {
    assert.deepEqual(parseMediaFormat(given), { ok: true, format: expected }, given);
  }
  for (const bad of ["docx", "gif", "", "  ", undefined, 42, null]) {
    const parsed = parseMediaFormat(bad);
    assert.equal(parsed.ok, false, String(bad));
    assert.match((parsed as { reason: string }).reason, /mp3, wav, m4a, flac, ogg, opus, mp4/);
  }
});

test("a point in the file is seconds, minutes and seconds, or hours too - and nothing given is nothing", () => {
  const seconds = (value: unknown) => { const parsed = parseClock(value); return parsed.ok ? parsed.seconds : parsed.reason; };
  for (const [given, expected] of [
    [undefined, undefined], [null, undefined], ["", undefined], [0, 0], [90, 90], ["90", 90], ["90s", 90], ["1.5", 1.5], [" 45 seconds ", 45],
    ["1:30", 90], ["0:05", 5], ["12:34", 754], ["1:30.5", 90.5], ["1:02:03", 3723], ["2m", 120], ["2 min 30 s", 150], ["1m30s", 90]
  ] as const) {
    assert.equal(seconds(given), expected, String(given));
  }
  for (const bad of ["soon", "1:99", "-5", "1:2:3:4", "ten", -1, Number.NaN, {}, "1:30pm"]) {
    const parsed = parseClock(bad, "start");
    assert.equal(parsed.ok, false, String(bad));
    assert.match((parsed as { reason: string }).reason, /start/);
  }
});

test("quality is small, normal or high, and anything else is normal", () => {
  assert.equal(parseQuality("small"), "small");
  assert.equal(parseQuality("Compressed"), "small");
  assert.equal(parseQuality("best"), "high");
  assert.equal(parseQuality("lossless"), "high");
  assert.equal(parseQuality("normal"), "normal");
  for (const other of [undefined, "", "medium-ish", 3, null]) assert.equal(parseQuality(other), "normal");
});

test("lengths read as people write them", () => {
  assert.equal(clockText(0), "0:00");
  assert.equal(clockText(7.4), "0:07");
  assert.equal(clockText(192.5), "3:13");
  assert.equal(clockText(3725), "1:02:05");
  assert.equal(clockText(-4), "0:00");
});

test("which part of a file is wanted: the whole, from a point, or between two, and what cannot be", () => {
  assert.deepEqual(planTrim(180, undefined, undefined), { ok: true, start: 0, length: 180, trimmed: false });
  assert.deepEqual(planTrim(180, 30, undefined), { ok: true, start: 30, length: 150, trimmed: true });
  assert.deepEqual(planTrim(180, 30, 90), { ok: true, start: 30, length: 60, trimmed: true });
  assert.deepEqual(planTrim(180, undefined, 20), { ok: true, start: 0, length: 20, trimmed: true });
  assert.deepEqual(planTrim(180, 0, 999), { ok: true, start: 0, length: 180, trimmed: false }, "an end past the end is the end");
  assert.deepEqual(planTrim(180, 170, 999), { ok: true, start: 170, length: 10, trimmed: true });
  assert.equal(planTrim(180, 90, 30).ok, false, "ending before it starts");
  assert.equal(planTrim(180, 30, 30).ok, false);
  assert.match((planTrim(180, 200, undefined) as { reason: string }).reason, /only 3:00 long, so it cannot start at 3:20/);
  assert.match((planTrim(180, 179.9, undefined) as { reason: string }).reason, /less than a quarter of a second/);
  // A file whose length is not known can be taken whole, from a point, or between two.
  assert.deepEqual(planTrim(null, undefined, undefined), { ok: true, start: 0, length: 0, trimmed: false });
  assert.deepEqual(planTrim(null, 10, undefined), { ok: true, start: 10, length: 0, trimmed: true });
  assert.deepEqual(planTrim(null, 10, 25), { ok: true, start: 10, length: 15, trimmed: true });
});

// ------------------------------------------------------------------------ what ffmpeg is told

const plan = { source: "C:\\songs\\neon.wav", output: "C:\\out\\neon.mp3", format: "mp3" as MediaFormat, quality: "normal" as const, start: 0, length: 0, hasAudio: true };

test("the whole song to MP3 is exactly these arguments, as a list, for local files only", () => {
  assert.deepEqual(ffmpegArgs(plan), [
    "-nostdin", "-hide_banner", "-v", "error", "-protocol_whitelist", "file",
    "-i", "C:\\songs\\neon.wav",
    "-vn", "-map", "0:a:0", "-map_metadata", "0",
    "-c:a", "libmp3lame", "-b:a", "192k", "-y", "C:\\out\\neon.mp3"
  ]);
});

test("a part of it is cut with a seek before the input and a length after it", () => {
  const args = ffmpegArgs({ ...plan, start: 30, length: 60 });
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4), ["-ss", "30", "-i", "C:\\songs\\neon.wav"]);
  assert.deepEqual(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2), ["-t", "60"]);
  assert.ok(args.indexOf("-ss") < args.indexOf("-i") && args.indexOf("-i") < args.indexOf("-t"), "seek, then input, then length");
  assert.equal(ffmpegArgs({ ...plan, start: 0, length: 0 }).includes("-ss"), false);
  assert.equal(ffmpegArgs({ ...plan, start: 12, length: 0 }).includes("-t"), false, "from a point to the end has no length");
});

test("every format has its own codec at each quality, and an MP4 keeps the sound only when there is some", () => {
  const codecs = (format: MediaFormat, quality: "small" | "normal" | "high") => ffmpegArgs({ ...plan, format, quality }).join(" ");
  assert.match(codecs("mp3", "small"), /-c:a libmp3lame -b:a 128k/);
  assert.match(codecs("mp3", "high"), /-c:a libmp3lame -b:a 320k/);
  assert.match(codecs("wav", "normal"), /-c:a pcm_s16le/);
  assert.match(codecs("m4a", "normal"), /-c:a aac -b:a 160k/);
  assert.match(codecs("flac", "normal"), /-c:a flac/);
  assert.match(codecs("ogg", "high"), /-c:a libvorbis -q:a 8/);
  assert.match(codecs("opus", "small"), /-c:a libopus -b:a 64k/);
  for (const format of mediaFormatList) {
    if (mediaFormats[format].kind === "audio") assert.match(codecs(format, "normal"), /-vn -map 0:a:0/, `${format} drops any picture`);
  }
  const withSound = ffmpegArgs({ ...plan, format: "mp4", quality: "normal" });
  assert.deepEqual(withSound.slice(withSound.indexOf("-map")), [
    "-map", "0:v:0", "-map", "0:a:0", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-y", "C:\\out\\neon.mp3"
  ]);
  const silent = ffmpegArgs({ ...plan, format: "mp4", hasAudio: false }).join(" ");
  assert.match(silent, /-map 0:v:0 -vf/);
  assert.doesNotMatch(silent, /0:a:0/);
  assert.match(ffmpegArgs({ ...plan, format: "mp4", quality: "small" }).join(" "), /-crf 28/);
  assert.match(ffmpegArgs({ ...plan, format: "mp4", quality: "high" }).join(" "), /-crf 19/);
});

test("a name that looks like an address, a concat or an option is only ever a file name to ffmpeg", () => {
  for (const source of ["http://example.com/song.mp3", "concat:a.mp3|b.mp3", "-i evil.mp3", "subfile,,start,0,end,0,,:C:\\x.mp3"]) {
    const args = ffmpegArgs({ ...plan, source });
    assert.deepEqual(args.slice(0, 6), ["-nostdin", "-hide_banner", "-v", "error", "-protocol_whitelist", "file"], "local files only, before the input");
    assert.equal(args[args.indexOf("-i") + 1], source, "passed whole, as one argument");
  }
});

// -------------------------------------------------------------------- what ffmpeg says about a file

test("what ffmpeg says about a file is read: how long, whether it has sound, whether it has a picture", () => {
  const song = [
    "ffmpeg version 8.0.1-full_build Copyright (c) 2000-2025 the FFmpeg developers",
    "Input #0, mp3, from 'song.mp3':",
    "  Duration: 00:03:12.34, start: 0.025057, bitrate: 192 kb/s",
    "  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 192 kb/s",
    "At least one output file must be specified"
  ].join("\n");
  const parsed = parseProbe(song);
  assert.ok(parsed.ok);
  assert.ok(Math.abs((parsed as { seconds: number }).seconds - 192.34) < 0.001);
  assert.deepEqual({ audio: (parsed as { audio: boolean }).audio, video: (parsed as { video: boolean }).video }, { audio: true, video: false });

  const withCover = parseProbe(`${song}\n  Stream #0:1: Video: mjpeg (Baseline), yuvj444p(pc), 500x500, 90k tbr (Attached pic)`);
  assert.equal((withCover as { video: boolean }).video, false, "cover art is not a video");

  const movie = parseProbe([
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':", "  Duration: 01:02:03.50, start: 0.000000, bitrate: 1200 kb/s",
    "  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1280x720, 25 fps", "  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo"
  ].join("\n"));
  assert.deepEqual({ seconds: (movie as { seconds: number }).seconds, audio: (movie as { audio: boolean }).audio, video: (movie as { video: boolean }).video }, { seconds: 3723.5, audio: true, video: true });

  const unknown = parseProbe("Input #0, wav, from 'x.wav':\n  Duration: N/A, bitrate: 1411 kb/s\n  Stream #0:0: Audio: pcm_s16le, 44100 Hz, stereo");
  assert.equal((unknown as { seconds: number | null }).seconds, null);
});

test("a file ffmpeg cannot open is reported with its own last words, without the banner", () => {
  const parsed = parseProbe("ffmpeg version 8.0.1 Copyright\n  built with gcc 15\n  libavutil      60.  8.100 / 60.  8.100\nx.mp3: Invalid data found when processing input\n");
  assert.equal(parsed.ok, false);
  assert.equal((parsed as { reason: string }).reason, "x.mp3: Invalid data found when processing input");
  assert.equal((parseProbe("") as { ok: boolean }).ok, false);
});

// ------------------------------------------------------------- with a stand-in for ffmpeg

type FakeFile = { seconds: number | null; audio: boolean; video: boolean; cover?: boolean; unreadable?: boolean };
type Behaviour = {
  convertFails?: string; convertTimesOut?: boolean; spawnError?: string; silent?: boolean; writesNothing?: boolean;
  producedSeconds?: number; brokenDecode?: string; decodeTimesOut?: boolean; unreadableOutput?: boolean;
};

const durationText = (seconds: number | null) => {
  if (seconds === null) return "N/A";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
};

/** Looks like ffmpeg to the converter: says what is in the files it is shown, makes the files it is asked to, and records every call. */
function fakeFfmpeg(known: Record<string, FakeFile>, behaviour: Behaviour = {}) {
  const files = new Map(Object.entries(known));
  const calls: string[][] = [];
  const run: RunFfmpeg = async (args) => {
    calls.push(args);
    if (behaviour.spawnError) return { code: null, stderr: "", timedOut: false, spawnError: behaviour.spawnError };
    const input = args[args.indexOf("-i") + 1];
    if (args.includes("-f") && args[args.indexOf("-f") + 1] === "null") {
      if (behaviour.decodeTimesOut) return { code: null, stderr: "", timedOut: true };
      return behaviour.brokenDecode ? { code: 1, stderr: `${behaviour.brokenDecode}\n`, timedOut: false } : { code: 0, stderr: "", timedOut: false };
    }
    if (args.includes("-y")) {
      if (behaviour.convertTimesOut) return { code: null, stderr: "", timedOut: true };
      if (behaviour.convertFails !== undefined) return { code: 1, stderr: `${behaviour.convertFails}\n`, timedOut: false };
      const output = args[args.length - 1];
      const from = files.get(input);
      const skip = args.includes("-ss") ? Number(args[args.indexOf("-ss") + 1]) : 0;
      const length = args.includes("-t") ? Number(args[args.indexOf("-t") + 1]) : null;
      if (!behaviour.writesNothing) writeFileSync(output, Buffer.alloc(4096, 1));
      files.set(output, {
        seconds: behaviour.producedSeconds ?? length ?? Math.max(0, (from?.seconds ?? 0) - skip),
        audio: !behaviour.silent, video: args.includes("libx264"), unreadable: behaviour.unreadableOutput
      });
      return { code: 0, stderr: "", timedOut: false };
    }
    const entry = files.get(input);
    if (!entry) return { code: 1, stderr: `${input}: No such file or directory\n`, timedOut: false };
    if (entry.unreadable) return { code: 1, stderr: `ffmpeg version 8.0.1\n${input}: Invalid data found when processing input\n`, timedOut: false };
    return {
      code: 1, timedOut: false,
      stderr: [
        "ffmpeg version 8.0.1-full_build Copyright (c) 2000-2025 the FFmpeg developers", `Input #0, test, from '${input}':`,
        `  Duration: ${durationText(entry.seconds)}, start: 0.000000, bitrate: 192 kb/s`,
        ...(entry.audio ? ["  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 192 kb/s"] : []),
        ...(entry.video ? ["  Stream #0:1: Video: h264 (High), yuv420p, 320x240, 15 fps"] : []),
        ...(entry.cover ? ["  Stream #0:2: Video: mjpeg (Baseline), yuvj444p, 500x500, 90k tbr (Attached pic)"] : []),
        "At least one output file must be specified"
      ].join("\n")
    };
  };
  return { run, calls, files };
}

/** A folder with a source file in it, and a stand-in that knows it. */
function setup(name: string, known: FakeFile, behaviour: Behaviour = {}) {
  const dir = folder();
  const out = path.join(dir, "out");
  const source = path.join(dir, name);
  mkdirSyncRecursive(dir);
  writeFileSync(source, Buffer.alloc(2048, 7));
  const fake = fakeFfmpeg({ [source]: known }, behaviour);
  return { dir, out, source, ...fake, options: { run: fake.run, ffmpegIsHere: () => true } };
}
const mkdirSyncRecursive = (dir: string) => { mkdirSync(dir, { recursive: true }); };

const song = { seconds: 192, audio: true, video: false };

test("a song becomes an MP3 beside the others, read back and checked, and the original is untouched", async () => {
  const s = setup("neon highway.wav", song);
  const before = createHash("sha256").update(readFileSync(s.source)).digest("hex");
  const result = await convertMedia({ source: s.source, to: "mp3" }, s.out, s.options);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.equal(result.file.name, "neon highway.mp3");
  assert.equal(result.file.path, path.join(s.out, "neon highway.mp3"));
  assert.equal(result.file.checked, true);
  assert.equal(result.file.seconds, 192);
  assert.deepEqual(result.problems, []);
  assert.equal(result.trimmed, null);
  assert.equal(existsSync(result.file.path), true);
  assert.equal(createHash("sha256").update(readFileSync(s.source)).digest("hex"), before, "the original is as it was");
  // Looked at the source, converted, looked at the result, played it through: in that order.
  assert.equal(s.calls.length, 4);
  assert.ok(!s.calls[0].includes("-y") && s.calls[0].includes("-i"), "first it looks at the source");
  assert.ok(s.calls[1].includes("libmp3lame") && s.calls[1].includes("-y"), "then it converts");
  assert.equal(s.calls[1][s.calls[1].length - 1], result.file.path);
  assert.ok(!s.calls[2].includes("-y"), "then it looks at what it made");
  assert.deepEqual(s.calls[3].slice(-3), ["-f", "null", "-"], "and plays it through to nowhere");
});

test("a part of a song is cut with the seek and length asked for, and the reply says which part", async () => {
  const s = setup("take.wav", song);
  const result = await convertMedia({ source: s.source, to: "flac", start: 30, end: 90, quality: "high" }, s.out, s.options);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.deepEqual(result.trimmed, { start: 30, length: 60 });
  assert.equal(result.file.seconds, 60);
  assert.equal(result.file.checked, true);
  const args = s.calls[1];
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2), ["-ss", "30"]);
  assert.deepEqual(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2), ["-t", "60"]);
  const text = describeMadeMedia(result);
  assert.match(text, /the part from 0:30 for 1:00/);
  assert.match(text, /\(FLAC audio, 1:00\)/);
});

test("a name is never taken twice: the next file is numbered, and nothing that was there is touched", async () => {
  const s = setup("same.wav", song);
  mkdirSyncRecursive(s.out);
  writeFileSync(path.join(s.out, "same.mp3"), "somebody's file");
  const first = await convertMedia({ source: s.source, to: "mp3" }, s.out, s.options);
  const second = await convertMedia({ source: s.source, to: "mp3" }, s.out, s.options);
  assert.ok(first.ok && second.ok);
  assert.equal(first.file.name, "same (2).mp3");
  assert.equal(second.file.name, "same (3).mp3");
  assert.equal(readFileSync(path.join(s.out, "same.mp3"), "utf8"), "somebody's file");
});

test("a title names the new file, in a name every system accepts", async () => {
  const s = setup("x.wav", song);
  const result = await convertMedia({ source: s.source, to: "ogg", title: 'Live: "Tour" / night?' }, s.out, s.options);
  assert.ok(result.ok);
  assert.equal(result.file.name, "Live Tour night.ogg");
});

test("ffmpeg failing leaves nothing behind and says what it complained of", async () => {
  const s = setup("a.wav", song, { convertFails: "Unknown encoder 'libmp3lame'" });
  const result = await convertMedia({ source: s.source, to: "mp3" }, s.out, s.options);
  assert.equal(result.ok, false);
  const reason = (result as { reason: string }).reason;
  assert.match(reason, /could not make MP3 audio from a\.wav: Unknown encoder 'libmp3lame'/);
  assert.match(reason, /Nothing was kept\.$/);
  assert.deepEqual(readdirSync(s.out), [], "the claimed name is given back");
});

test("a conversion that takes too long is stopped and nothing is kept; ffmpeg that cannot start is said so", async () => {
  const slow = setup("a.wav", song, { convertTimesOut: true });
  const timedOut = await convertMedia({ source: slow.source, to: "mp3" }, slow.out, slow.options);
  assert.match((timedOut as { reason: string }).reason, /took too long \(more than 10 minutes\)/);
  assert.deepEqual(readdirSync(slow.out), []);
  const broken = setup("b.wav", song, { spawnError: "spawn ffmpeg ENOENT" });
  const result = await convertMedia({ source: broken.source, to: "mp3" }, broken.out, broken.options);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /could not read b\.wav|could not be started/);
});

test("a result with no sound in it, or one that does not play through, or cannot be read back, is removed and said", async () => {
  const silent = setup("a.wav", song, { silent: true });
  const noSound = await convertMedia({ source: silent.source, to: "mp3" }, silent.out, silent.options);
  assert.match((noSound as { reason: string }).reason, /written with no sound in it, so it was removed/);
  assert.deepEqual(readdirSync(silent.out), []);

  const broken = setup("b.wav", song, { brokenDecode: "Error while decoding stream #0:0: Invalid data found" });
  const noPlay = await convertMedia({ source: broken.source, to: "mp3" }, broken.out, broken.options);
  assert.match((noPlay as { reason: string }).reason, /does not play through \(Error while decoding stream #0:0: Invalid data found\), so it was removed/);
  assert.deepEqual(readdirSync(broken.out), []);

  const unreadable = setup("c.wav", song, { unreadableOutput: true });
  const noRead = await convertMedia({ source: unreadable.source, to: "mp3" }, unreadable.out, unreadable.options);
  assert.match((noRead as { reason: string }).reason, /ffmpeg could not read it back/);
  assert.deepEqual(readdirSync(unreadable.out), []);

  const slowPlay = setup("d.wav", song, { decodeTimesOut: true });
  const stuck = await convertMedia({ source: slowPlay.source, to: "mp3" }, slowPlay.out, slowPlay.options);
  assert.match((stuck as { reason: string }).reason, /took too long to play it through/);
});

test("a result of the wrong length is kept, said to be wrong, and never called checked", async () => {
  const s = setup("a.wav", song, { producedSeconds: 95 });
  const result = await convertMedia({ source: s.source, to: "mp3" }, s.out, s.options);
  assert.ok(result.ok);
  assert.equal(result.file.checked, false);
  assert.match(result.problems[0], /is 1:35 long and should be about 3:12; open it and look before relying on it/);
  assert.equal(existsSync(result.file.path), true, "kept, for the person to look at");
  assert.doesNotMatch(describeMadeMedia(result), /read back and checked/);
  assert.match(describeMadeMedia(result), /open it and look/);

  // A few hundredths of a second either way is how encoders round, not a fault.
  const close = setup("b.wav", song, { producedSeconds: 192.4 });
  const fine = await convertMedia({ source: close.source, to: "mp3" }, close.out, close.options);
  assert.ok(fine.ok);
  assert.equal(fine.file.checked, true);
});

test("a video is made only from a file with a picture, keeps its sound, and says if the sound went missing", async () => {
  const movie = setup("clip.mov", { seconds: 60, audio: true, video: true });
  const made = await convertMedia({ source: movie.source, to: "mp4", quality: "small" }, movie.out, movie.options);
  assert.ok(made.ok, made.ok ? "" : made.reason);
  assert.match(movie.calls[1].join(" "), /libx264.*-crf 28/);
  assert.match(movie.calls[1].join(" "), /-map 0:a:0/);
  assert.equal(made.file.checked, true);
  assert.match(describeMadeMedia(made), /\(MP4 video, 1:00\)/);
  // A video is played through from near its end only, where a cut-short file shows.
  assert.deepEqual(movie.calls[3].slice(movie.calls[3].indexOf("-sseof"), movie.calls[3].indexOf("-sseof") + 2), ["-sseof", "-5"]);

  const noSound = setup("clip2.mov", { seconds: 60, audio: true, video: true }, { silent: true });
  const lost = await convertMedia({ source: noSound.source, to: "mp4" }, noSound.out, noSound.options);
  assert.ok(lost.ok);
  assert.equal(lost.file.checked, false);
  assert.match(lost.problems.join(" "), /has no sound, and the original had some/);

  const silentFilm = setup("film.mp4", { seconds: 30, audio: false, video: true });
  const quiet = await convertMedia({ source: silentFilm.source, to: "mp4" }, silentFilm.out, silentFilm.options);
  assert.ok(quiet.ok);
  assert.doesNotMatch(silentFilm.calls[1].join(" "), /0:a:0/, "no sound to take");

  const aSong = setup("only audio.mp3", song);
  const refused = await convertMedia({ source: aSong.source, to: "mp4" }, aSong.out, aSong.options);
  assert.equal(refused.ok, false);
  assert.match((refused as { reason: string }).reason, /has no picture, so it cannot become a video\. A music video can be made from a song with make_music_video/);
  assert.equal(aSong.calls.length, 1, "refused after only looking at it");
});

test("the sound is pulled out of a video, and cover art in a song is not taken for a picture", async () => {
  const movie = setup("talk.mp4", { seconds: 600, audio: true, video: true });
  const audio = await convertMedia({ source: movie.source, to: "mp3" }, movie.out, movie.options);
  assert.ok(audio.ok, audio.ok ? "" : audio.reason);
  assert.match(movie.calls[1].join(" "), /-vn -map 0:a:0/);
  const covered = setup("covered.mp3", { seconds: 100, audio: true, video: false, cover: true });
  const noVideo = await convertMedia({ source: covered.source, to: "mp4" }, covered.out, covered.options);
  assert.equal(noVideo.ok, false, "a cover is not a picture to make a video of");
  const silentFilm = setup("mute.mp4", { seconds: 30, audio: false, video: true });
  const noAudio = await convertMedia({ source: silentFilm.source, to: "mp3" }, silentFilm.out, silentFilm.options);
  assert.match((noAudio as { reason: string }).reason, /has no sound in it to make into MP3 audio/);
});

test("what cannot be converted is refused in words before anything is made", async () => {
  const s = setup("a.wav", song);
  const none = async (source: string, to: MediaFormat = "mp3", extra: { start?: number; end?: number } = {}, options = s.options) => convertMedia({ source, to, ...extra }, s.out, options);
  const reason = (result: Awaited<ReturnType<typeof none>>) => (result as { reason: string }).reason;

  assert.match(reason(await none(path.join(s.dir, "nothing.wav"))), /There is no file at /);
  assert.match(reason(await none(s.dir)), /is a folder, not a file/);
  writeFileSync(path.join(s.dir, "empty.wav"), "");
  assert.match(reason(await none(path.join(s.dir, "empty.wav"))), /empty\.wav is empty/);
  writeFileSync(path.join(s.dir, "notes.docx"), "words");
  assert.match(reason(await none(path.join(s.dir, "notes.docx"))), /is not an audio or video file this can convert\. It reads \.mp3, \.wav/);
  assert.match(reason(await none(s.source, "mp3", { start: 500 })), /only 3:12 long, so it cannot start at 8:20/);
  assert.match(reason(await none(s.source, "mp3", { start: 90, end: 30 })), /cannot end at 0:30 when it starts at 1:30/);
  assert.match(reason(await none(s.source, "mp3", {}, { run: s.run, ffmpegIsHere: () => false })), /ffmpeg is not installed.*Settings, Engine and models/);

  const broken = path.join(s.dir, "broken.mp3");
  writeFileSync(broken, Buffer.alloc(100, 1));
  const unreadable = fakeFfmpeg({ [broken]: { seconds: null, audio: false, video: false, unreadable: true } });
  assert.match(reason(await none(broken, "wav", {}, { run: unreadable.run, ffmpegIsHere: () => true })), /ffmpeg could not read broken\.mp3 \(.*Invalid data found when processing input\)/);
  assert.equal(readdirSync(s.dir).filter((name) => name.startsWith("broken") && name !== "broken.mp3").length, 0);
  assert.equal(existsSync(s.out), false, "no folder was made for what was refused");
});

test("a file whose length is not known is converted whole, or cut between two points", async () => {
  const s = setup("live.wav", { seconds: null, audio: true, video: false });
  const whole = await convertMedia({ source: s.source, to: "mp3" }, s.out, s.options);
  assert.ok(whole.ok, whole.ok ? "" : whole.reason);
  assert.equal(whole.file.checked, true, "nothing to compare its length with");
  assert.equal(s.calls[1].includes("-t"), false);
  const part = await convertMedia({ source: s.source, to: "mp3", start: 5, end: 20 }, s.out, s.options);
  assert.ok(part.ok);
  assert.equal(part.file.seconds, 15);
});

test("the reply names each file by where it is, in the line the screen reads", () => {
  const result = {
    ok: true as const, from: { name: "neon.wav", seconds: 192 }, trimmed: null, problems: [],
    file: { name: "neon.mp3", path: "C:\\work\\neon.mp3", bytes: 4_800_000, format: "mp3" as const, seconds: 192, checked: true }
  };
  const text = describeMadeMedia(result, () => "songs/neon.mp3");
  assert.match(text, /^Made MP3 audio from neon\.wav, read back and checked \(4\.6 MB\)\. It is saved here:\n- songs\/neon\.mp3 \(MP3 audio, 3:12\)\nThe original is untouched\.$/);
  assert.equal(describeMadeMedia({ ok: false, reason: "No." }), "No. Nothing was made.");
});

// ------------------------------------------------------------------ with the real ffmpeg

const skip = ffmpegAvailable() ? false : "there is no ffmpeg here";
const ffmpeg = (args: string[]) => execFileSync(ffmpegProgram(), ["-v", "error", "-y", ...args], { stdio: "pipe", timeout: 120_000 });

/**
 * A three-second tone, and two three-second films with a tone, made by ffmpeg itself: one an ordinary size, and one an odd size
 * (321 by 241), which H.264 will not take as it is and which a converter must therefore make even.
 */
function realSources() {
  const dir = folder();
  mkdirSyncRecursive(dir);
  const wav = path.join(dir, "tone.wav");
  const film = path.join(dir, "film.mp4");
  const odd = path.join(dir, "odd.mp4");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "44100", "-ac", "2", wav]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=3", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", film]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc=size=321x241:rate=15:duration=3", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", odd]);
  return { dir, wav, film, odd, out: path.join(dir, "out") };
}

test("a real tone becomes every audio format, each about three seconds long and played through", { skip }, async () => {
  const s = realSources();
  const before = createHash("sha256").update(readFileSync(s.wav)).digest("hex");
  for (const format of ["mp3", "wav", "m4a", "flac", "ogg", "opus"] as const) {
    const result = await convertMedia({ source: s.wav, to: format }, s.out);
    assert.ok(result.ok, `${format}: ${result.ok ? "" : result.reason}`);
    assert.equal(result.file.checked, true, format);
    assert.ok(Math.abs((result.file.seconds ?? 0) - 3) < 0.4, `${format} is ${result.file.seconds} seconds`);
    assert.ok(result.file.bytes > 1000, format);
    assert.equal(path.extname(result.file.name), `.${format}`);
  }
  assert.equal(createHash("sha256").update(readFileSync(s.wav)).digest("hex"), before, "the original is as it was");
  assert.equal(readdirSync(s.out).length, 6);
});

test("a real tone is cut to the part asked for", { skip }, async () => {
  const s = realSources();
  const result = await convertMedia({ source: s.wav, to: "mp3", start: 0.5, end: 2.5 }, s.out);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.ok(Math.abs((result.file.seconds ?? 0) - 2) < 0.3, `${result.file.seconds} seconds`);
  assert.deepEqual(result.trimmed, { start: 0.5, length: 2 });
});

test("the sound comes out of a real film, and the film becomes a smaller one with its picture and sound", { skip }, async () => {
  const s = realSources();
  const audio = await convertMedia({ source: s.film, to: "mp3" }, s.out);
  assert.ok(audio.ok, audio.ok ? "" : audio.reason);
  assert.ok(Math.abs((audio.file.seconds ?? 0) - 3) < 0.4);
  const film = await convertMedia({ source: s.film, to: "mp4", quality: "small", title: "Smaller" }, s.out);
  assert.ok(film.ok, film.ok ? "" : film.reason);
  assert.equal(film.file.checked, true);
  assert.equal(film.file.name, "Smaller.mp4");
  assert.ok(Math.abs((film.file.seconds ?? 0) - 3) < 0.5);
  const text = describeMadeMedia(film);
  assert.match(text, /\(MP4 video, 0:03\)/);

  // A film of an odd size is made even on the way, rather than refused by the encoder.
  const odd = await convertMedia({ source: s.odd, to: "mp4", title: "From odd" }, s.out);
  assert.ok(odd.ok, odd.ok ? "" : odd.reason);
  assert.equal(odd.file.checked, true);
});

test("a tone is no film: it is refused for want of a picture, and a file that is not media is refused with what ffmpeg said", { skip }, async () => {
  const s = realSources();
  const noPicture = await convertMedia({ source: s.wav, to: "mp4" }, s.out);
  assert.equal(noPicture.ok, false);
  assert.match((noPicture as { reason: string }).reason, /no picture/);
  const fake = path.join(s.dir, "notes.mp3");
  writeFileSync(fake, "this is a note, not a song");
  const garbage = await convertMedia({ source: fake, to: "wav" }, s.out);
  assert.equal(garbage.ok, false);
  assert.match((garbage as { reason: string }).reason, /ffmpeg could not read notes\.mp3/);
  assert.equal(existsSync(s.out) ? readdirSync(s.out).length : 0, 0, "nothing was left behind");
});
