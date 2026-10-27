import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  acceptedSongTypes, handSongOver, looksLikeSong, onSongHandedOver, refuseSong, songExtensions, sortGiven, strayNote, takeHandedSong
} from "../src/lib/songAttach";

// Attaching a song to the chat. The paperclip and the drop target took pictures
// only, so an mp3 given to either was ignored without a word.

const file = (name: string, type: string) => ({ name, type });

test("a song is recognised by what the browser says it is, or by its name when it says nothing", () => {
  assert.equal(looksLikeSong(file("neon highway.mp3", "audio/mpeg")), true);
  assert.equal(looksLikeSong(file("neon highway.MP3", "")), true, "no type, and capitals");
  assert.equal(looksLikeSong(file("demo.flac", "")), true, "a format the system may have no type for");
  assert.equal(looksLikeSong(file("take 2.opus", "application/octet-stream")), true);
  assert.equal(looksLikeSong(file("something", "audio/x-unknown")), true, "the browser calls it audio");
  assert.equal(looksLikeSong(file("photo.png", "image/png")), false);
  assert.equal(looksLikeSong(file("notes.txt", "text/plain")), false);
  assert.equal(looksLikeSong(file("clip.mp4", "video/mp4")), false, "a video is not a song");
  assert.equal(looksLikeSong(file("mp3", "")), false, "a name that only ends in the letters is not an extension");
});

test("every format the maker reads is accepted by the picker, in a form a file dialog understands", () => {
  const parts = acceptedSongTypes.split(",");
  assert.ok(parts.includes("audio/*"));
  for (const extension of songExtensions) assert.ok(parts.includes(extension), extension);
  assert.ok(songExtensions.includes(".mp3"), "the one people try first");
});

test("what is given is sorted: pictures, songs, and the rest, each in the order given", () => {
  const given = [
    file("b.png", "image/png"), file("one.mp3", "audio/mpeg"), file("readme.txt", "text/plain"),
    file("a.jpg", "image/jpeg"), file("two.wav", "audio/wav"), file("three.flac", "")
  ];
  const sorted = sortGiven(given);
  assert.deepEqual(sorted.images.map((f) => f.name), ["b.png", "a.jpg"]);
  assert.deepEqual(sorted.songs.map((f) => f.name), ["one.mp3", "two.wav", "three.flac"]);
  assert.deepEqual(sorted.other.map((f) => f.name), ["readme.txt"]);
  assert.deepEqual(sortGiven([]), { images: [], songs: [], other: [] });
});

test("an image is never taken for a song, whatever it is called", () => {
  const sorted = sortGiven([file("cover.mp3", "image/png")]);
  assert.equal(sorted.images.length, 1);
  assert.equal(sorted.songs.length, 0);
});

test("a song in a format the maker cannot read is refused in the maker's own words, naming what it can read", () => {
  assert.equal(refuseSong({ name: "a.mp3" }), null);
  assert.equal(refuseSong({ name: "A.MP3" }), null, "capitals are fine");
  for (const extension of songExtensions) assert.equal(refuseSong({ name: `x${extension}` }), null, extension);
  const refused = refuseSong({ name: "tune.mid" });
  assert.match(refused ?? "", /not a song file this can read/);
  assert.match(refused ?? "", /\.mp3/);
  assert.ok(refuseSong({ name: "noextension" }));
  assert.ok(refuseSong({ name: "song.mp3.exe" }));
  // What the service reports it can read is what counts once it has answered.
  assert.equal(refuseSong({ name: "a.wav" }, [".mp3"]) !== null, true);
  assert.equal(refuseSong({ name: "a.mp3" }, [".mp3"]), null);
  assert.match(refuseSong({ name: "a.wav" }, [".mp3"]) ?? "", /It can read \.mp3\./);
});

test("a file that is neither a picture nor a song is named, once", () => {
  assert.equal(strayNote([]), null);
  assert.match(strayNote([{ name: "notes.txt" }, { name: "b.zip" }]) ?? "", /"notes.txt" is not a picture or a song/);
  assert.match(strayNote([{ name: "" }]) ?? "", /"That file" is not a picture or a song/);
});

// ------------------------------------------------------------ the hand-over

test("a song handed over waits for the maker, and is taken once", () => {
  takeHandedSong();
  assert.equal(takeHandedSong(), null);
  handSongOver({ name: "a.mp3", bytes: 10, path: "workspace/a.mp3" });
  assert.deepEqual(takeHandedSong(), { name: "a.mp3", bytes: 10, path: "workspace/a.mp3" });
  assert.equal(takeHandedSong(), null, "taking it empties the place it waits");
});

test("a second song handed over before the first was taken replaces it", () => {
  handSongOver({ name: "first.mp3", bytes: 1, path: "workspace/first.mp3" });
  handSongOver({ name: "second.mp3", bytes: 2, path: "workspace/second.mp3" });
  assert.equal(takeHandedSong()?.name, "second.mp3");
  assert.equal(takeHandedSong(), null);
});

test("an open maker is told the moment a song is handed over, and can take it then", () => {
  takeHandedSong();
  const taken: string[] = [];
  const stop = onSongHandedOver(() => { const song = takeHandedSong(); if (song) taken.push(song.name); });
  handSongOver({ name: "live.mp3", bytes: 3, path: "workspace/live.mp3" });
  assert.deepEqual(taken, ["live.mp3"]);
  assert.equal(takeHandedSong(), null, "taken by the one that was told");
  stop();
  handSongOver({ name: "later.mp3", bytes: 4, path: "workspace/later.mp3" });
  assert.deepEqual(taken, ["live.mp3"], "a maker that has closed is not told");
  assert.equal(takeHandedSong()?.name, "later.mp3", "and the song waits for the next one to open");
});

// ------------------------------------------------------- the screens use it

const source = (relative: string) => readFileSync(path.join(import.meta.dirname, "..", "src", relative), "utf8");

test("the chat's paperclip accepts songs as well as pictures, and sends what is chosen through the sorter", () => {
  const provider = source("os/state/assistant.tsx");
  const input = provider.slice(provider.indexOf("<input"), provider.indexOf("/>", provider.indexOf("<input")));
  assert.match(input, /accept=\{`\$\{acceptedImageTypes\},\$\{acceptedSongTypes\}`\}/, "the picker lists both kinds");
  assert.match(input, /addFiles\(files\)/, "and what is chosen goes through the sorter, not the picture path alone");
  assert.match(provider, /handSongOver\(/, "a song is handed to the maker");
  assert.match(provider, /go\("music"\)/, "and the maker is opened");
});

test("a song dropped anywhere on a screen reaches the sorter too, once", () => {
  const shell = source("os/shell/AppShell.tsx");
  assert.match(shell, /looksLikeSong\(file\)/);
  assert.match(shell, /!event\.defaultPrevented/, "a song dropped on the maker's own box is not taken twice");
  assert.match(shell, /void addFiles\(files\)/);
  assert.doesNotMatch(shell, /void addImages\(files\)/, "the picture-only path is no longer the one a drop takes");
});

test("the maker and the chat read the same list of formats, and the maker takes a song that is handed to it", () => {
  const view = source("os/views/MusicVideoView.tsx");
  assert.doesNotMatch(view, /\[".mp3", ".wav"/, "no second copy of the list");
  assert.match(view, /songExtensions/);
  assert.match(view, /takeHandedSong\(\)/);
  assert.match(view, /onSongHandedOver\(/);
});
