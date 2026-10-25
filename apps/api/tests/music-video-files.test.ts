import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const root = mkdtempSync(path.join(tmpdir(), "trhai-mv-files-"));
process.env.ASCEND_WORKSPACE = root;

const { listMusicVideos, musicVideoReadiness, parseMusicVideoRequest, pruneUploads, safeFileName, saveUpload } = await import("../src/services/musicVideoFiles.js");
const uploads = path.join(root, "music-videos", "_uploads");

test.after(() => { rmSync(root, { recursive: true, force: true }); });

const ok = (body: unknown) => {
  const parsed = parseMusicVideoRequest(body);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.ok ? parsed.request : (undefined as never);
};
const refused = (body: unknown) => {
  const parsed = parseMusicVideoRequest(body);
  assert.equal(parsed.ok, false, JSON.stringify(body));
  return parsed.ok ? "" : parsed.message;
};

test("a request needs a song and nothing else, and passes on only what it was given", () => {
  assert.deepEqual(ok({ audio: "music-videos/_uploads/a.mp3" }), { audio: "music-videos/_uploads/a.mp3" });
  assert.deepEqual(
    ok({ audio: "a.mp3", title: "T", artist: "A", lyrics: "one\ntwo", words: "none", palette: "ember", height: 720, cover: false, previewSeconds: 20, folder: "music-videos/x" }),
    { audio: "a.mp3", title: "T", artist: "A", lyrics: "one\ntwo", words: "none", palette: "ember", height: 720, cover: false, previewSeconds: 20, folder: "music-videos/x" }
  );
  assert.equal(ok({ audio: "a.mp3", palette: "auto" }).palette, undefined, "auto means let the song choose");
  assert.equal(ok({ audio: "a.mp3", height: "1080" }).height, 1080, "a number sent as text");
  assert.equal(ok({ audio: "a.mp3", previewSeconds: "12" }).previewSeconds, 12);
  assert.equal(ok({ audio: "a.mp3", lyrics: "" }).lyrics, "", "empty lyrics are still lyrics, and mean none");
});

test("a request that is not right is refused, in words that say which part", () => {
  assert.match(refused(null), /JSON object/);
  assert.match(refused([]), /JSON object/);
  assert.match(refused("song.mp3"), /JSON object/);
  assert.match(refused({}), /audio is required/);
  assert.match(refused({ audio: "" }), /audio is required/);
  assert.match(refused({ audio: 7 }), /audio is required/);
  assert.match(refused({ audio: "x".repeat(401) }), /audio is required/);
  assert.match(refused({ audio: "a.mp3", title: "x".repeat(201) }), /title/);
  assert.match(refused({ audio: "a.mp3", title: 5 }), /title/);
  assert.match(refused({ audio: "a.mp3", artist: "x".repeat(201) }), /artist/);
  assert.match(refused({ audio: "a.mp3", lyrics: "x".repeat(60_001) }), /lyrics/);
  assert.match(refused({ audio: "a.mp3", words: "some" }), /words must be/);
  assert.match(refused({ audio: "a.mp3", palette: "rainbow" }), /palette must be/);
  assert.match(refused({ audio: "a.mp3", height: 1000 }), /height must be/);
  assert.match(refused({ audio: "a.mp3", height: "tall" }), /height must be/);
  assert.match(refused({ audio: "a.mp3", cover: "yes" }), /cover must be/);
  assert.match(refused({ audio: "a.mp3", previewSeconds: 2 }), /previewSeconds/);
  assert.match(refused({ audio: "a.mp3", previewSeconds: 61 }), /previewSeconds/);
  assert.match(refused({ audio: "a.mp3", previewSeconds: "soon" }), /previewSeconds/);
  assert.match(refused({ audio: "a.mp3", folder: 3 }), /folder/);
});

test("a file name from anywhere becomes a name that is safe to write", () => {
  assert.equal(safeFileName("C:\\Music\\My Song (final).mp3"), "My Song (final).mp3");
  assert.equal(safeFileName("../../etc/passwd.mp3"), "passwd.mp3");
  assert.equal(safeFileName("bad:name*?.MP3"), "bad_name_.mp3");
  assert.equal(safeFileName(".hidden.mp3"), "hidden.mp3");
  assert.equal(safeFileName("Señor Ünïcode ♪.wav"), "Señor Ünïcode _.wav");
  assert.equal(safeFileName("x".repeat(200) + ".mp3"), "x".repeat(80) + ".mp3");
  assert.equal(safeFileName(".mp3"), "mp3", "a name that is only an extension has no extension, and is then refused as not a song");
  assert.equal(safeFileName(""), "song");
  assert.equal(safeFileName("a   b.flac"), "a b.flac");
});

const stream = (...parts: Buffer[]) => Readable.from(parts);
const uploadedFiles = () => (existsSync(uploads) ? readdirSync(uploads) : []);

test("a song is written to the workspace as it arrives", async () => {
  const data = Buffer.alloc(200_000, 7);
  const saved = await saveUpload(stream(data.subarray(0, 70_000), data.subarray(70_000)), "My Song.MP3");
  assert.ok(saved.ok);
  if (!saved.ok) return;
  assert.match(saved.path, /^music-videos\/_uploads\/\d+-My Song\.mp3$/);
  assert.equal(saved.bytes, 200_000);
  assert.deepEqual(readFileSync(path.join(root, saved.path)), data);
});

test("what is not a song, is empty, is too big or breaks off is refused, and leaves nothing behind", async () => {
  const before = uploadedFiles();
  const notSong = await saveUpload(stream(Buffer.from("MZ")), "setup.exe");
  assert.deepEqual([notSong.ok, notSong.ok ? 0 : notSong.status], [false, 415]);
  const noName = await saveUpload(stream(Buffer.from("x")), "");
  assert.equal(noName.ok, false);
  const announced = await saveUpload(stream(Buffer.from("x")), "a.mp3", 500 * 1024 * 1024);
  assert.deepEqual([announced.ok, announced.ok ? 0 : announced.status], [false, 413], "refused on its announced size, without reading it");
  const empty = await saveUpload(stream(), "a.mp3");
  assert.deepEqual([empty.ok, empty.ok ? 0 : empty.status], [false, 400]);
  const big = await saveUpload(stream(Buffer.alloc(600), Buffer.alloc(600), Buffer.alloc(600)), "a.mp3", undefined, 1000);
  assert.deepEqual([big.ok, big.ok ? 0 : big.status], [false, 413], "and on its real size, as it arrives");
  const broken = new Readable({ read() { this.push(Buffer.alloc(100)); this.destroy(new Error("connection lost")); } });
  const lost = await saveUpload(broken, "a.mp3");
  assert.deepEqual([lost.ok, lost.ok ? 0 : lost.status], [false, 400]);
  assert.deepEqual(uploadedFiles(), before, "no half-written song is left");
});

test("songs that were uploaded and never used are cleared after three days", () => {
  mkdirSync(uploads, { recursive: true });
  const old = path.join(uploads, "old.mp3");
  const fresh = path.join(uploads, "fresh.mp3");
  writeFileSync(old, "x");
  writeFileSync(fresh, "x");
  const recent = path.join(uploads, "two-days.mp3");
  writeFileSync(recent, "x");
  const longAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
  const twoDays = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(old, longAgo, longAgo);
  utimesSync(recent, twoDays, twoDays);
  pruneUploads();
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true, "two days is not yet three");
  assert.equal(existsSync(fresh), true);
});

function makeVideoFolder(name: string, info: Record<string, unknown>, extra: { lyrics?: string[]; thumbnail?: boolean; video?: boolean; badInfo?: boolean } = {}) {
  const folder = path.join(root, "music-videos", name);
  mkdirSync(folder, { recursive: true });
  if (extra.video !== false) writeFileSync(path.join(folder, "video.mp4"), Buffer.alloc(1234));
  writeFileSync(path.join(folder, "info.json"), extra.badInfo ? "{ nope" : JSON.stringify(info));
  if (extra.lyrics) writeFileSync(path.join(folder, "lyrics.json"), JSON.stringify({ lines: extra.lyrics.map((text) => ({ text, start: 0, end: 1 })) }));
  if (extra.thumbnail) writeFileSync(path.join(folder, "thumbnail.jpg"), "jpg");
}
const info = (title: string, madeAt: string) => ({ title, artist: "A", seconds: 60, height: 720, bpm: 120, palette: "neon", cover: false, preview: false, song: "song.mp3", lyricsTiming: "heard", warnings: [], madeAt });

test("the videos already made are listed, newest first, with their lyrics, and half-made ones are left out", () => {
  // Named so that the order they are found in on the disk is the opposite of the order they are shown in.
  makeVideoFolder("a-older", info("Older", "2026-10-01T10:00:00.000Z"), { lyrics: ["one", "two"], thumbnail: true });
  makeVideoFolder("b-newer", info("Newer", "2026-10-02T10:00:00.000Z"));
  makeVideoFolder("no-video", info("Broken", "2026-10-03T10:00:00.000Z"), { video: false });
  makeVideoFolder("bad-info", info("Bad", "2026-10-04T10:00:00.000Z"), { badInfo: true });
  const listed = listMusicVideos();
  assert.deepEqual(listed.map((entry) => entry.title), ["Newer", "Older"]);
  const older = listed[1];
  assert.equal(older.folder, "music-videos/a-older");
  assert.equal(older.video, "music-videos/a-older/video.mp4");
  assert.equal(older.thumbnail, "music-videos/a-older/thumbnail.jpg");
  assert.equal(older.lyrics, "one\ntwo");
  assert.equal(older.bytes, 1234);
  assert.equal(listed[0].thumbnail, null);
  assert.equal(listed[0].lyrics, "");
  rmSync(path.join(root, "music-videos"), { recursive: true, force: true });
  assert.deepEqual(listMusicVideos(), [], "none, and no error, before anything is made");
});

test("what this PC is ready for is reported in a shape the screen can use", () => {
  const ready = musicVideoReadiness({ TRHAI_FFMPEG_PATH: path.join(root, "nope.exe") });
  assert.equal(typeof ready.ffmpeg, "boolean");
  assert.equal(typeof ready.listening, "boolean");
  assert.deepEqual(ready.palettes.find((palette) => palette.id === "neon"), { id: "neon", label: "Neon", top: "#4de8ff", bottom: "#ff2fa8" }, "with its colours, for a swatch");
  assert.ok(ready.extensions.includes(".mp3") && ready.extensions.includes(".wav"));
  assert.equal(ready.longestSeconds, 900);
});
