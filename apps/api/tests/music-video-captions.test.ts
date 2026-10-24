import test from "node:test";
import assert from "node:assert/strict";
import { buildCaptions, escapeText, fitLyric, stamp } from "../src/services/musicVideoCaptions.js";
import { geometryFor, palettes } from "../src/services/musicVideoLook.js";
import type { LyricLine, Word } from "../src/services/lyricTiming.js";

const g = geometryFor(720);
const neon = palettes[0];

/** A line sung evenly from `start` for `length` seconds, a word at a time, with an optional pause before word number `pauseAt`. */
function line(text: string, start: number, length: number, pause?: { before: number; seconds: number }): LyricLine {
  const parts = text.split(" ");
  const each = (length - (pause?.seconds ?? 0)) / parts.length;
  let t = start;
  const words: Word[] = parts.map((part, i) => {
    if (pause && i === pause.before) t += pause.seconds;
    const word = { text: part, start: t, end: t + each * 0.9, confidence: 0.9 };
    t += each;
    return word;
  });
  return { text, start, end: words[words.length - 1].end, words, confidence: 0.9 };
}

const captions = (lines: LyricLine[], extra: Partial<Parameters<typeof buildCaptions>[0]> = {}) =>
  buildCaptions({ geometry: g, palette: neon, title: "Neon Highway", artist: "The Test Band", duration: 60, lines, ...extra });

type Event = { layer: number; start: string; end: string; style: string; text: string };
function events(file: string): Event[] {
  const [, body] = file.split("[Events]\n");
  return body.split("\n").filter((row) => row.startsWith("Dialogue: ")).map((row) => {
    const fields = row.slice("Dialogue: ".length).split(",");
    return { layer: Number(fields[0]), start: fields[1], end: fields[2], style: fields[3], text: fields.slice(9).join(",") };
  });
}
const seconds = (clock: string) => {
  const [h, m, s] = clock.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};
/** The syllables of a karaoke line: each tag with its length in hundredths, and the text it covers. */
function syllables(text: string): Array<{ kind: string; cs: number; text: string }> {
  const out: Array<{ kind: string; cs: number; text: string }> = [];
  for (const match of text.matchAll(/\{\\(kf|k)(\d+)\}([^{]*)/g)) out.push({ kind: match[1], cs: Number(match[2]), text: match[3] });
  return out;
}
const visible = (text: string) => text.replace(/\{[^}]*\}/g, "");

test("times are written the way ASS wants them", () => {
  assert.equal(stamp(0), "0:00:00.00");
  assert.equal(stamp(62.5), "0:01:02.50");
  assert.equal(stamp(3725.123), "1:02:05.12");
  assert.equal(stamp(0.995), "0:00:01.00");
  assert.equal(stamp(-4), "0:00:00.00");
});

test("nothing in the text can open a tag or start a code", () => {
  assert.equal(escapeText("{oh} yeah"), "(oh) yeah");
  assert.equal(escapeText("a" + String.fromCharCode(92) + "Nb"), "a/Nb");
  assert.equal(escapeText("  two\t\nlines  "), "two lines");
  assert.equal(escapeText("\u0007bell"), "bell");
  assert.equal(escapeText("héllo ♪ wörld"), "héllo ♪ wörld");
});

test("a line of lyrics is set on one row if it fits, and on more, a little smaller, only if it does not", () => {
  const room = 1280 - 2 * Math.round(1280 * 0.047);
  const base = Math.round(720 * 0.064);
  const short = fitLyric("We are running down the highway".split(" "), 1280, 720);
  assert.deepEqual([short.breaks, short.size], [[], base], "31 letters is one row");

  const two = fitLyric("We are running down the highway tonight and nothing can ever stop us now".split(" "), 1280, 720);
  assert.equal(two.breaks.length, 1, "a longer line takes two rows");
  assert.ok(two.size < base && two.size >= Math.round(base * 0.8), `two rows are a little smaller: ${two.size}`);
  const words = "We are running down the highway tonight and nothing can ever stop us now".split(" ");
  const first = words.slice(0, two.breaks[0]).join(" ").length;
  const second = words.slice(two.breaks[0]).join(" ").length;
  assert.ok(Math.abs(first - second) <= 12, `the rows are about even: ${first} and ${second}`);

  const three = fitLyric(Array.from({ length: 26 }, (_, i) => `word${i}`), 1280, 720);
  assert.equal(three.breaks.length, 2, "and a very long one three");

  const endless = fitLyric(Array.from({ length: 80 }, (_, i) => `longerword${i}`), 1280, 720);
  assert.equal(endless.breaks.length, 2);
  assert.ok(endless.size >= Math.round(base * 0.5), "shrunk, but never below half");

  for (const count of [1, 5, 9, 14, 20]) {
    const row = fitLyric(Array.from({ length: count }, () => "sixletter"), 1280, 720);
    const rows = [0, ...row.breaks, count].slice(0, -1).map((from, i) => ([0, ...row.breaks, count][i + 1] - from) * 10 - 1);
    assert.ok(Math.max(...rows) * 0.56 * row.size <= room + 1, `${count} words: ${Math.max(...rows)} letters at ${row.size}`);
  }
  assert.deepEqual(fitLyric([], 1280, 720).breaks, [], "nothing to fit is not an error");
  assert.deepEqual(fitLyric(["one"], 1280, 720).breaks, []);
});

test("the file declares the picture's size and the styles it uses", () => {
  const file = captions([line("We are running", 5, 3)]);
  assert.ok(file.startsWith("[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\n"), "the picture size");
  assert.ok(file.includes("WrapStyle: 2"), "rows are broken by the program, not the renderer");
  for (const style of ["Lyric", "Title", "Artist", "Credit"]) assert.ok(file.includes(`Style: ${style},Bahnschrift,`), style);
  const lyricStyle = file.split("\n").find((row) => row.startsWith("Style: Lyric,"))!;
  const fields = lyricStyle.split(",");
  assert.equal(fields[3], "&H00FFE84D", "the word being sung is the palette's colour, blue-green-red");
  assert.equal(fields[4], "&H00FFFFFF", "the words still to come are white");
  assert.equal(fields[18], "2", "bottom centre");
  assert.ok(buildCaptions({ geometry: g, palette: neon, title: "x", artist: "", duration: 9, lines: [], font: "Segoe UI, Semibold\n" }).includes("Style: Lyric,Segoe UI  Semibold,"), "a font name cannot break the style row");
  // The field count matches the format row, for every style and every event.
  const format = file.split("\n").find((row) => row.startsWith("Format: Name,"))!.split(",").length;
  for (const row of file.split("\n").filter((r) => r.startsWith("Style: "))) assert.equal(row.split(",").length, format, row);
});

test("the title sits in the middle of the disc, with the artist under it, and stays to the end", () => {
  const found = events(captions([]));
  const title = found.find((event) => event.style === "Title")!;
  const artist = found.find((event) => event.style === "Artist")!;
  assert.ok(title && artist, "both are shown");
  const position = (event: Event) => event.text.match(/\\pos\((\d+),(\d+)\)/)!.slice(1).map(Number);
  const [tx, ty] = position(title);
  const [ax, ay] = position(artist);
  assert.equal(tx, g.centreX);
  assert.equal(ax, g.centreX);
  assert.ok(Math.abs(ty - g.centreY) < g.inner * 0.5 && ty < g.centreY, `the title is at ${ty}, the disc's middle is ${g.centreY}`);
  assert.ok(ay > ty && Math.abs(ay - g.centreY) < g.inner * 0.6, `the artist is below it, at ${ay}`);
  assert.equal(visible(title.text), `NEON${String.fromCharCode(92)}NHIGHWAY`);
  assert.equal(visible(artist.text), "THE TEST BAND");
  assert.equal(seconds(title.end), 60);
  assert.ok(seconds(title.start) <= 0.4 && seconds(artist.start) > seconds(title.start), "the title comes in first");
  assert.ok(title.text.includes("\\fad(700,2500)"), "and goes out with the picture");
  // No artist, no artist line - and the title is then centred.
  const alone = events(captions([], { artist: "" }));
  assert.equal(alone.filter((event) => event.style === "Artist").length, 0);
  assert.ok(Math.abs(position(alone.find((event) => event.style === "Title")!)[1] - g.centreY) < 3, "centred when alone");
});

test("a very short song still shows its title", () => {
  const found = events(captions([], { duration: 1 }));
  const title = found.find((event) => event.style === "Title")!;
  assert.ok(seconds(title.start) <= 0.25 + 1e-9 && seconds(title.end) === 1, `${title.start} to ${title.end}`);
});

test("with the cover in the disc, the title is a small credit in the corner", () => {
  const found = events(captions([], { cover: true }));
  assert.equal(found.filter((event) => event.style === "Title" || event.style === "Artist").length, 0);
  const credit = found.filter((event) => event.style === "Credit");
  assert.equal(credit.length, 1);
  assert.equal(visible(credit[0].text), "NEON HIGHWAY   ·   THE TEST BAND");
  assert.equal(seconds(credit[0].end), 60);
  assert.equal(visible(events(captions([], { cover: true, artist: "" })).find((event) => event.style === "Credit")!.text), "NEON HIGHWAY");
});

test("each word is lit as it is sung, and the line's own timing is kept", () => {
  const found = events(captions([line("Nothing left to hold us back", 10, 3)])).filter((event) => event.style === "Lyric");
  assert.equal(found.length, 1);
  const lyric = found[0];
  assert.ok(Math.abs(seconds(lyric.start) - 9.85) < 0.011, `appears just before: ${lyric.start}`);
  assert.equal(visible(lyric.text), "Nothing left to hold us back");
  const parts = syllables(lyric.text);
  // The first word starts 0.15 s after the line appears, as a delay.
  assert.deepEqual([parts[0].kind, parts[0].cs], ["k", 15]);
  const sung = parts.filter((p) => p.kind === "kf");
  assert.deepEqual(sung.map((p) => p.text.trim()), ["Nothing", "left", "to", "hold", "us", "back"]);
  // Words half a second apart fill for half a second each, with no stutter between them; the last for as long as it was sung.
  assert.ok(sung.slice(0, 5).every((p) => Math.abs(p.cs - 50) <= 1), sung.map((p) => p.cs).join(","));
  assert.ok(Math.abs(sung[5].cs - 45) <= 1, `the last word: ${sung[5].cs}`);
  // The sweep ends where the last word ends.
  const total = parts.reduce((sum, p) => sum + p.cs, 0);
  assert.ok(Math.abs(total - 310) <= 3, `${total} hundredths from the line's appearing to its last word's end`);
  assert.equal(parts.filter((p) => p.kind === "k").length, 1, "and no pauses are made where there were none");
});

test("a pause inside a line is a delay, so the next word does not light early", () => {
  const found = events(captions([line("hold on tight now", 20, 4, { before: 2, seconds: 1.5 })])).filter((event) => event.style === "Lyric");
  const parts = syllables(found[0].text);
  const delays = parts.filter((p) => p.kind === "k");
  assert.equal(delays.length, 2, "the lead-in, and the pause");
  assert.ok(Math.abs(delays[1].cs - 156) <= 3, `a pause of 1.5 s, and the gap that is always between words, is ${delays[1].cs} hundredths`);
  assert.deepEqual(parts.filter((p) => p.kind === "kf").map((p) => p.text.trim()), ["hold", "on", "tight", "now"]);
  // Delays carry no text, so the words read straight through.
  assert.equal(visible(found[0].text), "hold on tight now");
});

test("a line too long for one row breaks between words, and the lit words carry on across the break", () => {
  const long = "We are running down the highway tonight and nothing can ever stop us now";
  const found = events(captions([line(long, 5, 6)])).filter((event) => event.style === "Lyric");
  const text = found[0].text;
  const breaks = text.split(String.fromCharCode(92) + "N").length - 1;
  assert.equal(breaks, 1);
  assert.ok(text.includes("\\fs"), "set a little smaller");
  assert.equal(visible(text).split(String.fromCharCode(92) + "N").join(" "), long);
  assert.equal(syllables(text).filter((p) => p.kind === "kf").length, 14, "every word still has its own sweep");
});

test("lines never overlap: one is taken down before the next goes up", () => {
  const a = line("first line here", 10, 2.2);
  const b = line("second line follows", 12.4, 2.2);
  const c = line("third much later", 30, 2);
  const found = events(captions([c, b, a])).filter((event) => event.style === "Lyric");
  assert.deepEqual(found.map((event) => visible(event.text)), ["first line here", "second line follows", "third much later"], "in time order");
  assert.ok(seconds(found[0].end) <= seconds(found[1].start) + 1e-9, `${found[0].end} before ${found[1].start}`);
  assert.ok(seconds(found[0].end) > seconds(found[0].start) + 1, "and still on for a while");
  // It is the first that gives way: the second comes up when it is sung, not when the first would have gone.
  assert.ok(Math.abs(seconds(found[1].start) - 12.25) < 0.011, `the second comes up at ${found[1].start}`);
  assert.ok(seconds(found[2].end) - seconds(found[2].start) >= 2, "a line with room goes a little past its last word");
  // Even touching lines: the first goes before the second arrives.
  const close = events(captions([line("one two", 5, 1), line("three four", 5.9, 1)])).filter((event) => event.style === "Lyric");
  assert.ok(seconds(close[0].end) <= seconds(close[1].start), `${close[0].end} ${close[1].start}`);
  assert.ok(Math.abs(seconds(close[1].start) - 5.75) < 0.011, `the second comes up at ${close[1].start}`);
});

test("two lines that start almost together still do not share the screen", () => {
  const found = events(captions([line("quick one", 20, 0.1), line("and the next", 20.2, 1)])).filter((event) => event.style === "Lyric");
  assert.equal(found.length, 2, "both are shown");
  assert.ok(seconds(found[0].end) <= seconds(found[1].start) + 1e-9, `${found[0].end} before ${found[1].start}`);
  assert.ok(seconds(found[1].end) > seconds(found[1].start) + 0.5, "and the second still has its time");
});

test("a short line stays up long enough to read when nothing is waiting behind it", () => {
  const found = events(captions([line("go", 20, 0.3)])).filter((event) => event.style === "Lyric");
  assert.ok(seconds(found[0].end) - seconds(found[0].start) >= 1.2 - 1e-6, `${found[0].start} to ${found[0].end}`);
});

test("lyrics are kept inside the song, empty lines are dropped, and odd characters cannot break the file", () => {
  const tail = line("last words", 58.8, 3);
  const empty: LyricLine = { text: "", start: 3, end: 4, words: [], confidence: 1 };
  const odd = line("{braces} and back" + String.fromCharCode(92) + "slash", 40, 2);
  const found = events(captions([tail, empty, odd])).filter((event) => event.style === "Lyric");
  assert.equal(found.length, 2);
  assert.ok(found.every((event) => seconds(event.end) <= 60), "none runs past the end");
  const text = visible(found[0].text);
  assert.equal(text, "(braces) and back/slash");
  for (const event of found) assert.ok(!/[{}]/.test(visible(event.text)), "no stray braces");
  assert.equal(events(captions([])).filter((event) => event.style === "Lyric").length, 0, "no lyrics, no lyric lines");
});

test("a line whose words were only guessed is still shown, and times that start before zero are held at zero", () => {
  const early: LyricLine = { text: "early bird", start: -0.5, end: 1.2, confidence: 0.2, words: [{ text: "early", start: -0.5, end: 0.4, confidence: 0.2 }, { text: "bird", start: 0.4, end: 1.2, confidence: 0.2 }] };
  const found = events(captions([early])).filter((event) => event.style === "Lyric");
  assert.equal(found.length, 1);
  assert.equal(found[0].start, "0:00:00.00");
  assert.equal(visible(found[0].text), "early bird");
  assert.ok(syllables(found[0].text).every((p) => p.cs >= 0), "no negative times");
});
