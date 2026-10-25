// Lyrics with times: from what whisper.cpp heard in a song, and from lyrics a
// person has pasted in. Pure functions; lyricTranscribe.ts runs whisper.
//
// Whisper is good at words and only fair at singing over a band, so two things
// are done here. Timing: its attention-based word times (DTW) are used when it
// has them, since its ordinary word times are stretched across the quiet parts
// between lines (a line sung at 8 s was placed at 0 s). And correction: pasted
// lyrics are lined up against what it heard, word by word, so that a word it
// got wrong or missed does not move the others.

export type Word = {
  text: string;
  start: number;
  end: number;
  /** How sure the recogniser was, 0 to 1; 1 for a word taken from lyrics a person wrote. */
  confidence: number;
};

export type LyricLine = {
  text: string;
  start: number;
  end: number;
  words: Word[];
  confidence: number;
};

const special = /^(\[.*\]|<\|.*\|>)$/;

// ---------------------------------------------------------------- whisper's output

type WhisperToken = { text?: unknown; offsets?: { from?: unknown; to?: unknown }; p?: unknown; t_dtw?: unknown };
type WhisperSegment = { text?: unknown; offsets?: { from?: unknown; to?: unknown }; tokens?: WhisperToken[] };

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The words whisper heard, with times, from its `-ojf` JSON output (run with
 * `-ml 1 -sow`, and `-dtw` if it can). Notes it makes about the sound, like
 * "[MUSIC]" or "(upbeat music)", are not words and are left out.
 */
export function wordsFromWhisper(json: unknown, duration: number): Word[] {
  const segments = (json as { transcription?: WhisperSegment[] } | null)?.transcription;
  if (!Array.isArray(segments)) return [];

  type Piece = { text: string; start: number; end: number; p: number; startsWord: boolean };
  const pieces: Piece[] = [];
  const haveDtw = segments.some((segment) => segment.tokens?.some((token) => (num(token.t_dtw) ?? -1) >= 0));
  for (const segment of segments) {
    const tokens = segment.tokens ?? [];
    for (const token of tokens) {
      const text = typeof token.text === "string" ? token.text : "";
      if (!text.trim() || special.test(text.trim())) continue;
      const dtw = num(token.t_dtw);
      const from = (num(token.offsets?.from) ?? num(segment.offsets?.from) ?? 0) / 1000;
      const to = (num(token.offsets?.to) ?? num(segment.offsets?.to) ?? from * 1000) / 1000;
      // Centiseconds, when present; otherwise the coarse segment time.
      const start = haveDtw && dtw !== null && dtw >= 0 ? dtw / 100 : from;
      pieces.push({ text, start, end: to, p: num(token.p) ?? 0.5, startsWord: /^\s/.test(text) });
    }
  }
  if (pieces.length === 0) return [];

  // A word is a piece that starts with a space, and the pieces after it that do not (word endings, punctuation).
  const words: Word[] = [];
  let probabilities: number[] = [];
  const close = () => {
    const last = words[words.length - 1];
    if (last) last.confidence = probabilities.reduce((a, b) => a + b, 0) / Math.max(1, probabilities.length);
    probabilities = [];
  };
  pieces.forEach((piece, index) => {
    if (piece.startsWord || words.length === 0 || index === 0) {
      close();
      words.push({ text: piece.text.trim(), start: piece.start, end: piece.end, confidence: piece.p });
    } else {
      words[words.length - 1].text += piece.text.trim();
      words[words.length - 1].end = Math.max(words[words.length - 1].end, piece.end);
    }
    probabilities.push(piece.p);
  });
  close();

  // Notes in brackets or parentheses, which can arrive as several words ("[", "Music", "]").
  const kept: Word[] = [];
  let closing: string | null = null;
  for (const word of words) {
    if (closing) {
      if (word.text.includes(closing)) closing = null;
      continue;
    }
    const opens = word.text.startsWith("[") ? "]" : word.text.startsWith("(") ? ")" : null;
    if (opens) {
      if (!word.text.includes(opens)) closing = opens;
      continue;
    }
    if (/^[^\p{L}\p{N}]+$/u.test(word.text)) continue; // punctuation on its own
    kept.push(word);
  }

  // A word lasts until the next one starts, within reason: the pauses between lines are not part of any word.
  for (let i = 0; i < kept.length; i += 1) {
    const next = kept[i + 1];
    const natural = Math.min(kept[i].end > kept[i].start ? kept[i].end - kept[i].start : 0.35, 1.2);
    const until = next ? Math.min(next.start, kept[i].start + 1.2) : kept[i].start + Math.max(0.35, natural);
    kept[i].end = Math.max(kept[i].start + 0.12, Math.min(until, duration > 0 ? duration : until));
  }
  return kept;
}

// ---------------------------------------------------------------- matching words

const plainOf = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** The edit distance between two short words. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** Whether a recognised word is the lyric's word, allowing a slip or two in a long word. */
function sameWord(lyric: string, heard: string): boolean {
  if (!lyric || !heard) return false;
  if (lyric === heard) return true;
  const limit = lyric.length >= 8 ? 2 : lyric.length >= 4 ? 1 : 0;
  return limit > 0 && distance(lyric, heard) <= limit;
}

// ---------------------------------------------------------------- lyrics a person wrote

/** A heading on its own line, as lyrics sites put them: "Verse 2:", "Chorus", "Bridge -". */
const sectionHeading = /^(?:intro|verse|pre-?chorus|chorus|post-?chorus|hook|refrain|bridge|interlude|instrumental|solo|outro)(?:\s*\d+)?\s*[:\-]?$/i;

/**
 * Lyrics as they are pasted from a lyrics site, ready to be timed: one entry
 * for each line that is sung. Blank lines, headings such as "[Chorus]" or
 * "Verse 2:", and lines with nothing but punctuation in them are dropped.
 */
export function cleanLyrics(text: string, limit = 400): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || /^\[[^\]]*\]$/.test(line) || sectionHeading.test(line) || !/[\p{L}\p{N}]/u.test(line)) continue;
    lines.push(line);
    if (lines.length >= limit) break;
  }
  return lines;
}

export type Alignment = {
  lines: LyricLine[];
  /** How many of the lyric's words were found in what was heard, 0 to 1. Low means the times are mostly guesses. */
  matched: number;
};

/**
 * Times for lyrics a person pasted in. Each word is lined up with the same
 * word in what was heard, in order (a global alignment, so a word that was
 * missed or misheard costs one gap and moves nothing else); words with no
 * counterpart are timed between their neighbours.
 */
export function alignLyrics(lyrics: string[], heard: Word[], duration: number): Alignment {
  const lyricWords: Array<{ line: number; text: string; plain: string }> = [];
  lyrics.forEach((line, lineIndex) => {
    for (const text of line.split(/\s+/).filter(Boolean)) lyricWords.push({ line: lineIndex, text, plain: plainOf(text) });
  });
  const n = lyricWords.length;
  const m = heard.length;
  const plainHeard = heard.map((word) => plainOf(word.text));

  // Needleman-Wunsch: a match is worth 2, a mismatch -1, a gap -1.
  const score: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 1; i <= n; i += 1) score[i][0] = -i;
  for (let j = 1; j <= m; j += 1) score[0][j] = -j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const diagonal = score[i - 1][j - 1] + (sameWord(lyricWords[i - 1].plain, plainHeard[j - 1]) ? 2 : -1);
      score[i][j] = Math.max(diagonal, score[i - 1][j] - 1, score[i][j - 1] - 1);
    }
  }
  const counterpart = new Array<number>(n).fill(-1);
  for (let i = n, j = m; i > 0 && j > 0;) {
    const isMatch = sameWord(lyricWords[i - 1].plain, plainHeard[j - 1]);
    if (score[i][j] === score[i - 1][j - 1] + (isMatch ? 2 : -1)) {
      if (isMatch) counterpart[i - 1] = j - 1;
      i -= 1;
      j -= 1;
    } else if (score[i][j] === score[i - 1][j] - 1) {
      i -= 1;
    } else {
      j -= 1;
    }
  }

  // Times: a found word takes the time it was heard; the rest are spread between the found ones.
  const starts = new Array<number>(n).fill(NaN);
  const ends = new Array<number>(n).fill(NaN);
  counterpart.forEach((j, i) => { if (j >= 0) { starts[i] = heard[j].start; ends[i] = heard[j].end; } });
  const found = counterpart.map((j, i) => (j >= 0 ? i : -1)).filter((i) => i >= 0);
  // How long a word usually lasts in this song, from the ones that were heard.
  const lasts = found.map((i) => ends[i] - starts[i]).filter((d) => d > 0.1 && d < 1.2).sort((a, b) => a - b);
  const perWord = lasts.length ? Math.max(0.2, Math.min(0.6, lasts[Math.floor(lasts.length / 2)])) : 0.4;
  for (let i = 0; i < n; i += 1) {
    if (!Number.isNaN(starts[i])) continue;
    const before = [...found].reverse().find((k) => k < i);
    const after = found.find((k) => k > i);
    const line = lyricWords[i].line;
    const headOfLine = after !== undefined && lyricWords[after].line === line && (before === undefined || lyricWords[before].line !== line);
    const tailOfLine = before !== undefined && lyricWords[before].line === line && (after === undefined || lyricWords[after].line !== line);
    if (headOfLine) {
      // The first words of a line that were not heard sit just before the first one that was: the quiet is before the line, not inside it.
      ends[i] = (starts[after as number]) - perWord * ((after as number) - i - 1) - 0.03;
      starts[i] = Math.max(before !== undefined ? ends[before] : 0, ends[i] - perWord);
    } else if (tailOfLine) {
      starts[i] = ends[before as number] + perWord * (i - (before as number) - 1) + 0.03;
      ends[i] = starts[i] + perWord;
    } else if (before !== undefined && after !== undefined) {
      // Inside a line, or in a whole line nothing of which was heard: share the time between the neighbours equally.
      const between = after - before - 1;
      const slot = Math.max(starts[after] - ends[before], 0.12 * between) / between;
      starts[i] = ends[before] + slot * (i - before - 1);
      ends[i] = starts[i] + Math.max(0.12, Math.min(slot * 0.9, 1));
    } else if (before !== undefined) {
      starts[i] = ends[before] + perWord * (i - before - 1) + 0.05;
      ends[i] = starts[i] + perWord;
    } else if (after !== undefined) {
      ends[i] = starts[after] - perWord * (after - i - 1) - 0.05;
      starts[i] = Math.max(0, ends[i] - perWord);
    }
  }
  if (found.length === 0) return { lines: [], matched: 0 };
  // Keep the words in order and inside the song.
  for (let i = 0; i < n; i += 1) {
    if (i > 0 && starts[i] < starts[i - 1]) starts[i] = starts[i - 1];
    starts[i] = Math.max(0, Math.min(starts[i], Math.max(0, duration - 0.2)));
    ends[i] = Math.max(starts[i] + 0.12, Math.min(ends[i], duration > 0 ? duration : ends[i]));
    if (i + 1 < n && ends[i] > Math.max(starts[i + 1], starts[i] + 0.12)) ends[i] = Math.max(starts[i] + 0.12, starts[i + 1]);
  }

  const lines: LyricLine[] = [];
  lyrics.forEach((text, lineIndex) => {
    const indexes = lyricWords.map((word, i) => (word.line === lineIndex ? i : -1)).filter((i) => i >= 0);
    if (indexes.length === 0) return;
    const words: Word[] = indexes.map((i) => ({ text: lyricWords[i].text, start: starts[i], end: ends[i], confidence: counterpart[i] >= 0 ? Math.max(0.5, heard[counterpart[i]].confidence) : 0.3 }));
    lines.push({
      text: text.trim(),
      start: words[0].start,
      end: words[words.length - 1].end,
      words,
      confidence: words.reduce((a, w) => a + w.confidence, 0) / words.length
    });
  });
  return { lines, matched: found.length / n };
}

/**
 * Lyrics with no recognition to time them by (the listening tool is not
 * installed, or heard nothing): the lines spread evenly between `from` and
 * `to`. These are only approximate and are marked so.
 */
export function spreadLyrics(lyrics: string[], from: number, to: number): LyricLine[] {
  const lines = lyrics.map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || to <= from) return [];
  const slot = (to - from) / lines.length;
  return lines.map((text, index) => {
    const start = from + slot * index;
    const end = start + Math.min(slot * 0.9, 6);
    const pieces = text.split(/\s+/).filter(Boolean);
    const each = (end - start) / pieces.length;
    return { text, start, end, confidence: 0.2, words: pieces.map((word, w) => ({ text: word, start: start + each * w, end: start + each * (w + 1), confidence: 0.2 })) };
  });
}

// ---------------------------------------------------------------- lyrics found from the sound alone

/** What a recogniser tends to say about silence and music, and nothing else. */
const hallucinations = new Set(["you", "thank you", "thanks for watching", "bye", "okay", "oh", "so", "the", "yeah"]);

/**
 * Lines made from the words heard, when nobody supplied lyrics. A line ends at
 * a pause, at the end of a sentence, or when it gets long; lines it is not
 * sure of, and the stock phrases a recogniser invents over silence, are left
 * out - captions that are wrong are worse than none.
 */
export function linesFromWords(words: Word[], options: { minConfidence?: number } = {}): LyricLine[] {
  const minConfidence = options.minConfidence ?? 0.3;
  const groups: Word[][] = [];
  let current: Word[] = [];
  const flush = () => { if (current.length) groups.push(current); current = []; };
  words.forEach((word, i) => {
    const previous = words[i - 1];
    const gap = previous ? word.start - previous.end : 0;
    const length = current.reduce((a, w) => a + w.text.length + 1, 0);
    const sentenceEnded = previous && /[.?!]$/.test(previous.text) && gap > 0.25;
    if (current.length && (gap >= 0.9 || sentenceEnded || current.length >= 8 || length + word.text.length > 44)) flush();
    current.push(word);
  });
  flush();

  const lines: LyricLine[] = groups.map((group) => ({
    text: group.map((w) => w.text).join(" "),
    start: group[0].start,
    end: group[group.length - 1].end,
    words: group,
    confidence: group.reduce((a, w) => a + w.confidence, 0) / group.length
  }));
  const kept = lines.filter((line) => {
    const plain = plainOf(line.text);
    if (line.confidence < minConfidence) return false;
    if (hallucinations.has(line.text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim()) && line.confidence < 0.7) return false;
    return plain.length >= 2;
  });
  // The same line over and over is a recogniser stuck, not a chorus (a real chorus has sung words in between).
  return kept.filter((line, i) => !(i >= 2 && plainOf(line.text) === plainOf(kept[i - 1].text) && plainOf(line.text) === plainOf(kept[i - 2].text)));
}

// ---------------------------------------------------------------- deciding what goes on the screen

export type LyricsTiming = "none" | "heard" | "approximate";

export type LyricPlan = {
  lines: LyricLine[];
  /** Whose words they are: the ones pasted in, the ones heard, or none. */
  source: "pasted" | "heard" | "none";
  timing: LyricsTiming;
  /** What the person should know about how far to trust it, in plain words. */
  warnings: string[];
};

export type LyricPlanInput = {
  /** Lines pasted in, already cleaned. */
  pasted: string[];
  /** What was heard in the song, or null when it could not be listened to; `why` then says why. */
  heard: { words: Word[]; timed: boolean } | null;
  why?: string;
  /** Seconds of the video being made. */
  duration: number;
  /** Seconds of the whole song: longer than `duration` for a preview. */
  fullDuration?: number;
  /** Where the singing can be taken to start and stop, when the song's structure says. Used only to spread lyrics that could not be timed. */
  singingFrom?: number;
  singingTo?: number;
};

/**
 * What goes on the screen, from what was pasted and what was heard, and what to
 * tell the person about it. Pasted words are the better words and heard words
 * the better times, so when both exist the words are theirs and the times the
 * singing's; when the singing could not be made out the lines are spread
 * evenly and said to be only approximate. Heard words alone are shown, with a
 * warning, only if they read as words.
 */
export function planLyrics(input: LyricPlanInput): LyricPlan {
  const { pasted, heard, duration } = input;
  const full = Math.max(input.fullDuration ?? duration, duration);
  // A preview hears only the start of the song: judge it by the part of the song it heard, and show only lines that fall in it.
  const preview = full > duration + 0.5;
  const warnings: string[] = [];
  const within = (lines: LyricLine[]) => lines.filter((line) => line.start < duration - 0.3);

  const spread = (reason: string): LyricPlan => {
    const first = !preview && input.singingFrom !== undefined ? input.singingFrom : full * 0.06;
    const last = !preview && input.singingTo !== undefined ? input.singingTo : full * 0.96;
    warnings.push(`${reason} Your lyrics are spread evenly over the song, so the lines will not line up exactly with the singing.`);
    return { lines: within(spreadLyrics(pasted, first, Math.max(first + 1, last))), source: "pasted", timing: "approximate", warnings };
  };

  if (pasted.length > 0) {
    if (!heard) return spread(input.why ?? "The song could not be listened to.");
    const aligned = alignLyrics(pasted, heard.words, duration);
    const matched = Math.min(1, aligned.matched / Math.min(1, duration / full));
    if (matched >= 0.25 && aligned.lines.length > 0) {
      if (matched < 0.6) warnings.push(`Only ${Math.round(matched * 100)}% of your words could be found in the singing, so the lines are timed between the words that were. Check the video, and fix any line that is off.`);
      return { lines: within(aligned.lines), source: "pasted", timing: heard.timed ? "heard" : "approximate", warnings };
    }
    return spread("The singing could not be made out well enough to time your words by.");
  }

  if (!heard) {
    warnings.push(`There are no lyrics on the video: ${input.why ?? "the song could not be listened to"}`);
    return { lines: [], source: "none", timing: "none", warnings };
  }
  const lines = linesFromWords(heard.words);
  if (lines.length === 0) {
    warnings.push("No words could be made out in the song, so there are no lyrics on the video. Paste them in to have them shown.");
    return { lines: [], source: "none", timing: "none", warnings };
  }
  warnings.push("These lyrics were worked out by listening, and singing over a band is hard to hear: they will have mistakes. Paste the real ones in to have them shown instead.");
  return { lines, source: "heard", timing: heard.timed ? "heard" : "approximate", warnings };
}
