import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alignLyrics, cleanLyrics, linesFromWords, planLyrics, spreadLyrics, wordsFromWhisper, type Word } from "../src/services/lyricTiming.js";

// Real output: whisper.cpp (base.en, run with -ml 1 -sow, with and without -dtw) on a 68 s
// test song in which Piper speaks twelve known lines over a synthetic band at known times.
// The truth file holds when each line was placed; the voice starts about 0.2 s into its slot.

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const dtw = fixture("whisper-words-dtw.json");
const plain = fixture("whisper-words-plain.json");
const truth = fixture("test-song-truth.json") as { duration: number; lines: Array<{ text: string; start: number; end: number }> };

const normal = (text: string) => text.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
const word = (text: string, start: number, end: number, confidence = 0.9): Word => ({ text, start, end, confidence });

test("whisper's word times are used when it has them, so a line is placed where it is sung", () => {
  const words = wordsFromWhisper(dtw, truth.duration);
  assert.ok(words.length >= 70, `${words.length} words heard`);
  assert.equal(words[0].text, "I");
  // Sung at 8.25 s with a 0.2 s lead-in: the ordinary segment time said 0.0 s.
  assert.ok(Math.abs(words[0].start - 8.45) < 0.2, `the first word starts at ${words[0].start}`);
  for (let i = 1; i < words.length; i += 1) assert.ok(words[i].start >= words[i - 1].start, "in order");
  for (const w of words) assert.ok(w.end > w.start && w.end <= truth.duration + 0.01, `${w.text} ${w.start}-${w.end}`);

  const lines = linesFromWords(words);
  assert.ok(lines.length >= 10 && lines.length <= 14, `${lines.length} lines`);
  let found = 0;
  for (const spoken of truth.lines.slice(0, 6)) {
    const line = lines.find((candidate) => Math.abs(candidate.start - (spoken.start + 0.2)) < 0.5);
    if (line && normal(line.text).split(" ").filter((w) => normal(spoken.text).includes(w)).length >= normal(spoken.text).split(" ").length - 1) found += 1;
  }
  assert.ok(found >= 5, `${found} of the first six lines came out with the right words at the right time`);
});

test("without the attention times the words are still returned, from the coarse ones", () => {
  const words = wordsFromWhisper(plain, truth.duration);
  assert.ok(words.length >= 70);
  assert.equal(words[0].text, "I");
  assert.ok(words[0].end > words[0].start);
});

test("notes whisper makes about the sound, and bare punctuation, are not words", () => {
  const token = (text: string, from: number, to: number, t_dtw = -1) => ({ text, offsets: { from, to }, p: 0.9, t_dtw });
  const json = { transcription: [{ offsets: { from: 0, to: 4000 }, text: "x", tokens: [
    token("[_BEG_]", 0, 0), token(" [", 0, 300), token(" Music", 300, 900), token("]", 900, 1000),
    token(" hello", 1000, 1500), token(" (upbeat", 1500, 2000), token(" music)", 2000, 2500), token(" there", 2500, 3000), token(".", 3000, 3100), token(" ♪", 3100, 3300)
  ] }] };
  const words = wordsFromWhisper(json, 10);
  assert.deepEqual(words.map((w) => w.text), ["hello", "there."], "punctuation stays on its word, a lone note symbol is dropped");
  assert.deepEqual(wordsFromWhisper({}, 10), []);
  assert.deepEqual(wordsFromWhisper(null, 10), []);
});

test("pieces of a word are put back together and take the average certainty", () => {
  const token = (text: string, from: number, to: number, p: number) => ({ text, offsets: { from, to }, p, t_dtw: from / 10 });
  const json = { transcription: [{ offsets: { from: 0, to: 2000 }, text: "x", tokens: [token(" electr", 0, 500, 0.8), token("ic", 500, 900, 0.4), token(" black", 1000, 1600, 0.6), token(".", 1600, 1700, 0.2)] }] };
  const words = wordsFromWhisper(json, 10);
  assert.deepEqual(words.map((w) => w.text), ["electric", "black."]);
  assert.ok(Math.abs(words[0].confidence - 0.6) < 1e-9);
  assert.ok(Math.abs(words[1].confidence - 0.4) < 1e-9);
});

// ---------------------------------------------------------------- lyrics a person wrote

const lyrics = truth.lines.map((line) => line.text);

test("pasted lyrics get the times of the words that were heard", () => {
  const heard = wordsFromWhisper(dtw, truth.duration);
  const { lines, matched } = alignLyrics(lyrics, heard, truth.duration);
  assert.equal(lines.length, lyrics.length);
  assert.ok(matched > 0.85, `${Math.round(matched * 100)}% of the words found`);
  lines.forEach((line, i) => {
    assert.equal(line.text, lyrics[i], "the wording is the person's, not the recogniser's");
    assert.ok(Math.abs(line.start - (truth.lines[i].start + 0.2)) < 0.5, `line ${i + 1} starts at ${line.start}, was sung at about ${truth.lines[i].start + 0.2}`);
    assert.ok(line.end > line.start && line.end <= truth.duration + 0.01);
    assert.equal(line.words.length, lyrics[i].split(" ").length);
    if (i > 0) assert.ok(line.start >= lines[i - 1].start, "in order");
  });
  // The one line whisper got wrong ("Big my hand" for "Take my hand") is still timed.
  const wrong = lines.find((line) => line.text === "Take my hand and we will fly");
  assert.ok(wrong && wrong.words.every((w) => w.end > w.start));
});

test("a word that was missed, or misheard, moves nothing else", () => {
  const heard: Word[] = [
    word("we", 10.0, 10.3), word("are", 10.3, 10.6), word("running", 10.6, 11.2), word("down", 11.2, 11.6), word("the", 11.6, 11.8), word("highway", 11.8, 12.6),
    word("nothing", 14.0, 14.5), word("hold", 15.0, 15.4), word("us", 15.4, 15.6), word("back", 15.6, 16.2)
  ];
  const { lines, matched } = alignLyrics(["We are running down the highway", "Nothing left to hold us back"], heard, 30);
  assert.equal(lines.length, 2);
  assert.ok(Math.abs(lines[0].start - 10.0) < 0.01 && Math.abs(lines[0].end - 12.6) < 0.01, "the first line is exactly where it was heard");
  assert.ok(Math.abs(lines[1].start - 14.0) < 0.01, "the second starts at its first heard word");
  const left = lines[1].words[1];
  assert.ok(left.start >= 14.5 - 0.01 && left.end <= 15.0 + 0.2, `"left" is timed between "nothing" and "hold": ${left.start}-${left.end}`);
  const to = lines[1].words[2];
  assert.ok(to.start >= left.start && to.start < 15.0, `and "to" after it: ${to.start}`);
  assert.ok(Math.abs(matched - 10 / 12) < 0.01, `${matched}`);
  assert.ok(left.confidence < lines[1].words[0].confidence, "a guessed time is less certain than a heard one");
});

test("lyrics that share nothing with what was heard are not timed from it", () => {
  const heard = [word("completely", 1, 2), word("different", 2, 3)];
  assert.deepEqual(alignLyrics(["We are running down the highway"], heard, 20), { lines: [], matched: 0 });
  assert.deepEqual(alignLyrics(["anything at all"], [], 20), { lines: [], matched: 0 });
});

test("a couple of words in common are not enough to time lyrics by", () => {
  // "we" and "are" turn up in the singing, and nothing else of the lyrics does: not a match, a coincidence.
  const heard = [word("we", 5, 5.3), word("are", 5.3, 5.6), word("completely", 9, 10), word("different", 10, 11)];
  const plan = planLyrics({ pasted: lyrics, heard: { words: heard, timed: true }, duration: 68, singingFrom: 8, singingTo: 60 });
  assert.equal(plan.timing, "approximate");
  assert.match(plan.warnings.join(" "), /could not be made out well enough/);
  assert.ok(Math.abs(plan.lines[0].start - 8) < 1e-9, `spread from where the singing is taken to start, not placed at ${plan.lines[0].start}`);
});

test("lyrics with no recognition are spread evenly, and flagged as only approximate", () => {
  const spread = spreadLyrics(["one two", "three four five", "", "six"], 10, 40);
  assert.equal(spread.length, 3, "blank lines are dropped");
  assert.ok(Math.abs(spread[0].start - 10) < 1e-9 && spread[1].start > spread[0].end - 0.01);
  assert.ok(spread.every((line) => line.end <= 40 && line.confidence <= 0.2));
  assert.equal(spread[1].words.length, 3);
  assert.deepEqual(spreadLyrics(["a"], 10, 10), []);
  assert.deepEqual(spreadLyrics([], 0, 10), []);
});

// ---------------------------------------------------------------- lyrics from the sound alone

test("lines made from what was heard leave out what a recogniser invents over silence", () => {
  const words = [
    word("Thank", 1, 1.3, 0.4), word("you.", 1.3, 1.6, 0.4),
    word("We", 5, 5.3), word("are", 5.3, 5.6), word("running", 5.6, 6.2), word("down.", 6.2, 6.6),
    word("Nothing", 8, 8.4, 0.12), word("here", 8.4, 8.8, 0.1),
    word("Hold", 12, 12.3), word("on", 12.3, 12.5), word("tight", 12.5, 13.0)
  ];
  const lines = linesFromWords(words);
  assert.deepEqual(lines.map((line) => line.text), ["We are running down.", "Hold on tight"]);
  assert.ok(Math.abs(lines[0].start - 5) < 1e-9 && Math.abs(lines[0].end - 6.6) < 1e-9);
});

test("a recogniser stuck on one line three times is not a chorus", () => {
  const stuck: Word[] = [];
  for (let i = 0; i < 4; i += 1) { stuck.push(word("la", 2 + i * 3, 2.4 + i * 3), word("la", 2.4 + i * 3, 2.8 + i * 3)); }
  const lines = linesFromWords(stuck);
  assert.ok(lines.length <= 2, `${lines.length} lines`);
});

test("a long run of words is cut into lines at pauses, sentences, and a sensible length", () => {
  const words: Word[] = [];
  let t = 0;
  for (let i = 0; i < 20; i += 1) { words.push(word(`word${i}`, t, t + 0.3)); t += 0.35; }
  const lines = linesFromWords(words);
  assert.ok(lines.length >= 3, "never one endless line");
  assert.ok(lines.every((line) => line.words.length <= 8));
  assert.equal(lines.flatMap((line) => line.words).length, 20, "and every word is somewhere");
});

test("pasted lyrics lose their headings and blank lines, and keep every line that is sung", () => {
  const pasted = ["[Verse 1]", "We are running down the highway", "", "  Nothing left   to hold us back  ", "Chorus:", "Verse 2", "...", "---", "Hold on tight", "[Chorus]", "Bridge -", "1 2 3 4", "Señor, où est la plage?", "Outro"].join("\r\n");
  assert.deepEqual(cleanLyrics(pasted), ["We are running down the highway", "Nothing left to hold us back", "Hold on tight", "1 2 3 4", "Señor, où est la plage?"]);
  assert.deepEqual(cleanLyrics("Verse of the day is here\nChorus line one"), ["Verse of the day is here", "Chorus line one"], "a line that merely starts with a heading word is a line");
  assert.deepEqual(cleanLyrics("one\ntwo\nthree", 2), ["one", "two"], "bounded");
  assert.deepEqual(cleanLyrics(""), []);
});

// ---------------------------------------------------------------- what goes on the screen

const heardAll = () => ({ words: wordsFromWhisper(dtw, truth.duration), timed: true });

test("pasted lyrics and a good listening give the person's words at the singing's times, with nothing to warn about", () => {
  const plan = planLyrics({ pasted: lyrics, heard: heardAll(), duration: truth.duration });
  assert.equal(plan.source, "pasted");
  assert.equal(plan.timing, "heard");
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.lines.length, lyrics.length);
  assert.deepEqual(plan.lines.map((line) => line.text), lyrics);
  assert.equal(planLyrics({ pasted: lyrics, heard: { ...heardAll(), timed: false }, duration: truth.duration }).timing, "approximate", "coarse times are not called exact");
});

test("lyrics that the singing does not match are spread evenly, and the person is told", () => {
  const stranger = { words: [word("completely", 5, 6), word("different", 6, 7), word("words", 7, 8)], timed: true };
  const plan = planLyrics({ pasted: lyrics, heard: stranger, duration: 68, singingFrom: 8, singingTo: 60 });
  assert.equal(plan.timing, "approximate");
  assert.equal(plan.source, "pasted");
  assert.match(plan.warnings.join(" "), /could not be made out well enough/);
  assert.match(plan.warnings.join(" "), /spread evenly/);
  assert.equal(plan.lines.length, lyrics.length);
  assert.ok(Math.abs(plan.lines[0].start - 8) < 1e-9, `starts where the singing is taken to: ${plan.lines[0].start}`);
  assert.ok(plan.lines[plan.lines.length - 1].end <= 60 + 1e-9, "and stops where it stops");
  // Without structure to go by, the first and last stretch of a song are left alone.
  const blind = planLyrics({ pasted: lyrics, heard: null, why: "Listening is not installed.", duration: 68 });
  assert.ok(Math.abs(blind.lines[0].start - 68 * 0.06) < 1e-9, `${blind.lines[0].start}`);
  assert.match(blind.warnings[0], /^Listening is not installed\. Your lyrics are spread evenly/);
  assert.equal(planLyrics({ pasted: lyrics, heard: null, duration: 68 }).warnings.length, 1, "with a reason even when none was given");
});

test("lyrics found only in part of the singing are used, with a warning about how much was found", () => {
  const all = heardAll().words;
  // Every other word missing: about half were heard.
  const half = { words: all.filter((_, i) => i % 2 === 0), timed: true };
  const plan = planLyrics({ pasted: lyrics, heard: half, duration: truth.duration });
  assert.equal(plan.timing, "heard");
  assert.equal(plan.lines.length, lyrics.length, "every line is still shown");
  assert.match(plan.warnings.join(" "), /Only \d+% of your words could be found/);
  const percent = Number(/Only (\d+)%/.exec(plan.warnings.join(" "))![1]);
  assert.ok(percent >= 25 && percent < 60, `${percent}%`);
});

test("with no lyrics pasted, what was heard is shown only if it reads as words, and is called a guess", () => {
  const plan = planLyrics({ pasted: [], heard: heardAll(), duration: truth.duration });
  assert.equal(plan.source, "heard");
  assert.ok(plan.lines.length >= 10, `${plan.lines.length} lines`);
  assert.match(plan.warnings.join(" "), /worked out by listening/);
  assert.equal(plan.timing, "heard");
  const rubbish = planLyrics({ pasted: [], heard: { words: [word("Thank", 1, 1.3, 0.4), word("you.", 1.3, 1.6, 0.4)], timed: true }, duration: 30 });
  assert.deepEqual([rubbish.source, rubbish.timing, rubbish.lines.length], ["none", "none", 0]);
  assert.match(rubbish.warnings.join(" "), /No words could be made out/);
  const unable = planLyrics({ pasted: [], heard: null, why: "whisper.cpp is not installed.", duration: 30 });
  assert.deepEqual([unable.source, unable.lines.length], ["none", 0]);
  assert.match(unable.warnings[0], /whisper\.cpp is not installed\./);
});

test("a preview, which hears only the start of the song, is judged by the part it heard and shows only that part", () => {
  const start = heardAll().words.filter((w) => w.end < 25);
  const plan = planLyrics({ pasted: lyrics, heard: { words: start, timed: true }, duration: 25, fullDuration: truth.duration });
  assert.equal(plan.timing, "heard");
  assert.deepEqual(plan.warnings, [], "the lines not yet sung are not a poor match");
  assert.ok(plan.lines.length >= 3 && plan.lines.length < lyrics.length, `${plan.lines.length} of ${lyrics.length} lines`);
  assert.ok(plan.lines.every((line) => line.start < 25 - 0.3), "none starts after the preview ends");
  // Spread, a preview uses the whole song's span, then keeps what falls in the preview.
  const spread = planLyrics({ pasted: lyrics, heard: null, why: "Nothing to listen with.", duration: 25, fullDuration: 68 });
  assert.ok(Math.abs(spread.lines[0].start - 68 * 0.06) < 1e-9, `${spread.lines[0].start}`);
  assert.ok(spread.lines.length < lyrics.length && spread.lines.every((line) => line.start < 24.7), `${spread.lines.length} lines`);
});

// ---------------------------------------------------------------- a song that was only partly heard

test("a preview shows exactly the lines sung inside it, each where it was sung", () => {
  // Real whisper output cut at three lengths, against the twelve lines the voice really sang, four seconds apart from 8.25 s.
  const sungBy = (seconds: number) => truth.lines.filter((line) => line.start + 0.2 < seconds - 0.3).length;
  for (const [window, expected] of [[12, 1], [20, 3], [25, 5], [40, 8]] as const) {
    const heard = wordsFromWhisper(dtw, truth.duration).filter((w) => w.end < window);
    const plan = planLyrics({ pasted: lyrics, heard: { words: heard, timed: true }, duration: window, fullDuration: truth.duration });
    assert.equal(plan.lines.length, expected, `${window} s of the song shows ${plan.lines.length} lines`);
    assert.equal(sungBy(window), expected, "and that is how many were sung in it (fixture check)");
    plan.lines.forEach((line, i) => {
      assert.equal(line.text, lyrics[i]);
      assert.ok(Math.abs(line.start - (truth.lines[i].start + 0.2)) < 0.4, `${window} s: line ${i + 1} at ${line.start}, sung at about ${truth.lines[i].start + 0.2}`);
    });
  }
});

test("heard words land on the first place they fit, not the last: a repeated chorus is not a second chance", () => {
  const song = ["we are the champions my friends", "a verse that nobody hears", "we are the champions my friends", "and a last line to finish"];
  // Only the first chorus was heard, at 10 s.
  const heard = "we are the champions my friends".split(" ").map((text, i) => word(text, 10 + i * 0.4, 10.35 + i * 0.4));
  const { lines } = alignLyrics(song, heard, 60);
  assert.ok(Math.abs(lines[0].start - 10) < 0.01, `the first chorus is at ${lines[0].start}`);
  assert.ok(lines[2].start > lines[0].start + 1, `and the second is not put where the first was heard (${lines[2].start})`);
  assert.equal(lines[0].words.every((w) => w.confidence >= 0.5), true, "every word of the first chorus was found there");
  assert.equal(lines[2].words.some((w) => w.confidence >= 0.5), false, "and none of the second");
});

test("heard words that come before or after the lyrics, or only part of them, still find their place", () => {
  const song = ["first words here", "then the middle part", "and the ending words"];
  // The recogniser added a word of its own at each end, and missed the first line.
  const heard = [word("so", 5, 5.2), word("then", 20, 20.3), word("the", 20.3, 20.5), word("middle", 20.5, 21), word("part", 21, 21.4), word("yeah", 40, 40.3)];
  const { lines, matched } = alignLyrics(song, heard, 60);
  assert.ok(Math.abs(lines[1].start - 20) < 0.01 && Math.abs(lines[1].end - 21.4) < 0.01, `${lines[1].start}-${lines[1].end}`);
  assert.ok(lines[0].end <= 20.01, "the line before it was not heard and is placed before");
  assert.ok(lines[2].start >= 21.3, "and the line after it after");
  assert.ok(Math.abs(matched - 4 / 11) < 0.01, `${matched}: four of the eleven words were found`);
});
