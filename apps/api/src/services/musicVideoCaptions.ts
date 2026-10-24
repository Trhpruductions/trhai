// The words on a music video: the title inside the disc, and the lyrics along
// the bottom, lit word by word as they are sung. Written as an ASS subtitle
// file for ffmpeg's `subtitles` filter, which draws it with libass. Pure text
// in, text out, so the whole of it is tested.

import type { LyricLine } from "./lyricTiming.js";
import { assColour, type Geometry, type Palette, titleLayout } from "./musicVideoLook.js";

export type CaptionsInput = {
  geometry: Geometry;
  palette: Palette;
  /** Set when the song's cover is shown in the disc: the title then goes small in a corner instead. */
  cover?: boolean;
  title: string;
  artist: string;
  duration: number;
  lines: LyricLine[];
  /** The typeface; Windows ships Bahnschrift, and libass falls back to its own default when a name is missing. */
  font?: string;
};

const backslash = String.fromCharCode(92);
/** An ASS override block, such as {\an5\pos(640,300)}, written without the backslash escapes getting in the way. */
const tag = (...parts: string[]) => `{${parts.map((part) => backslash + part).join("")}}`;
const lineBreak = `${backslash}N`;

/** 0:01:02.50, the time notation ASS uses, to the nearest hundredth of a second. */
export function stamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(total / 360000);
  const minutes = Math.floor(total / 6000) % 60;
  const secs = Math.floor(total / 100) % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(total % 100).padStart(2, "0")}`;
}

/** Text as ASS will show it: braces would open a tag block and a backslash starts a code, so neither is allowed through. */
export function escapeText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\\/g, "/")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------- fitting a line of lyrics

/** The width of a character in this typeface, as a share of its size: wide enough that a line made to fit does. */
const glyphWidth = 0.56;

export type LyricFit = {
  /** The index of each word that starts a new row, after the first. */
  breaks: number[];
  /** The size to set it in, in the same units as the picture's height. */
  size: number;
};

/**
 * How to set a line of lyrics: on one row if it fits at the usual size, else on
 * two or three rows a little smaller, and shrunk only if even that does not fit.
 * Lines break between words, never inside one, at the places that keep the rows
 * most even.
 */
export function fitLyric(words: string[], width: number, height: number): LyricFit {
  const base = Math.round(height * 0.064);
  const room = width - 2 * Math.round(width * 0.047);
  const scale = [1, 0.84, 0.72];
  const rowLength = (from: number, to: number) => words.slice(from, to).join(" ").length;

  for (let rows = 1; rows <= 3; rows += 1) {
    const size = Math.round(base * scale[rows - 1]);
    const breaks = bestBreaks(words.length, rows, rowLength);
    const widest = Math.max(...rowsOf(words.length, breaks).map(([from, to]) => rowLength(from, to)));
    if (widest * glyphWidth * size <= room) return { breaks, size };
  }
  // Three rows, as evenly as can be, then smaller until they fit - but never too small to read.
  const breaks = bestBreaks(words.length, 3, rowLength);
  const widest = Math.max(...rowsOf(words.length, breaks).map(([from, to]) => rowLength(from, to)));
  const size = Math.max(Math.round(base * 0.5), Math.floor(room / (widest * glyphWidth)));
  return { breaks, size };
}

function rowsOf(count: number, breaks: number[]): Array<[number, number]> {
  const edges = [0, ...breaks, count];
  return edges.slice(0, -1).map((from, i) => [from, edges[i + 1]] as [number, number]);
}

/** The cut points that make the longest row as short as possible, for `rows` rows over `count` words. */
function bestBreaks(count: number, rows: number, rowLength: (from: number, to: number) => number): number[] {
  const usable = Math.min(rows, Math.max(1, count));
  if (usable === 1) return [];
  let best: number[] = [];
  let bestWidest = Infinity;
  const consider = (breaks: number[]) => {
    const widest = Math.max(...rowsOf(count, breaks).map(([from, to]) => rowLength(from, to)));
    if (widest < bestWidest) { best = breaks; bestWidest = widest; }
  };
  if (usable === 2) {
    for (let a = 1; a < count; a += 1) consider([a]);
  } else {
    for (let a = 1; a < count - 1; a += 1) for (let b = a + 1; b < count; b += 1) consider([a, b]);
  }
  return best;
}

// ---------------------------------------------------------------- the file

/** A gap between two words shorter than this is not shown as a pause. */
const pauseSeconds = 0.25;

function karaokeText(line: LyricLine, eventStart: number, fit: LyricFit): string {
  const words = line.words.map((word) => ({ ...word, text: escapeText(word.text) })).filter((word) => word.text.length > 0);
  let text = "";
  let cursor = 0; // hundredths of a second, from the start of the event, already accounted for
  words.forEach((word, i) => {
    const start = Math.max(cursor, Math.round((word.start - eventStart) * 100));
    // The fill carries on to the next word unless there is a real pause, so that it does not stutter between words.
    const next = words[i + 1];
    const reach = next && next.start - word.end < pauseSeconds ? Math.max(word.end, next.start) : word.end;
    const end = Math.max(start + 1, Math.round((Math.max(reach, word.start + 0.05) - eventStart) * 100));
    if (start > cursor) text += tag(`k${start - cursor}`);
    text += `${tag(`kf${end - start}`)}${word.text}`;
    cursor = end;
    if (i < words.length - 1) text += fit.breaks.includes(i + 1) ? lineBreak : " ";
  });
  return text;
}

export function buildCaptions(input: CaptionsInput): string {
  const { geometry: g, palette, duration } = input;
  const font = (input.font ?? "Bahnschrift").replace(/[,\r\n]/g, " ").trim() || "Bahnschrift";
  const layout = titleLayout(input.title, input.artist, g.inner * 2);
  const lyricBase = Math.round(g.height * 0.064);
  const creditSize = Math.round(g.height * 0.032);

  const styles = [
    // The word being sung is filled in the first colour; the words still to come are in the second.
    `Style: Lyric,${font},${lyricBase},${assColour(palette.sung)},${assColour(palette.unsung)},&HB0000000,&H80000000,-1,0,0,0,100,100,1,0,1,${(g.height * 0.0049).toFixed(1)},1,2,${Math.round(g.width * 0.047)},${Math.round(g.width * 0.047)},${Math.round(g.height * 0.09)},1`,
    `Style: Title,${font},${layout.titleSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,${Math.round(layout.titleSize * 0.09)},0,1,0,0,5,0,0,0,1`,
    `Style: Artist,${font},${Math.max(layout.artistSize, 9)},${assColour(0xc0c8d8)},${assColour(0xc0c8d8)},&H00000000,&H00000000,0,0,0,0,100,100,${Math.round(layout.artistSize * 0.2)},0,1,0,0,5,0,0,0,1`,
    `Style: Credit,${font},${creditSize},${assColour(0xffffff, 0x40)},${assColour(0xffffff, 0x40)},&H80000000,&H00000000,-1,0,0,0,100,100,2,0,1,1,0,7,${Math.round(g.width * 0.03)},0,${Math.round(g.height * 0.04)},1`
  ];

  const events: string[] = [];
  const dialogue = (layer: number, start: number, end: number, style: string, text: string) =>
    events.push(`Dialogue: ${layer},${stamp(start)},${stamp(end)},${style},,0,0,0,,${text}`);

  // The title: in the disc, or small in the corner when the cover has the disc.
  const titleFrom = Math.min(0.4, duration / 4);
  if (input.cover) {
    const credit = [escapeText(layout.lines.join(" ")), escapeText(layout.artist).toUpperCase()].filter(Boolean).join("   ·   ");
    dialogue(1, titleFrom, duration, "Credit", `${tag("fad(800,2500)")}${credit}`);
  } else {
    const block = layout.lines.length * layout.titleSize * 1.15;
    const gap = layout.artistSize > 0 ? layout.titleSize * 0.35 : 0;
    const artistHeight = layout.artistSize * 1.2;
    const top = g.centreY - (block + gap + artistHeight) / 2;
    dialogue(1, titleFrom, duration, "Title", `${tag("an5", `pos(${g.centreX},${Math.round(top + block / 2)})`, "fad(700,2500)")}${layout.lines.map(escapeText).join(lineBreak)}`);
    if (layout.artistSize > 0) {
      dialogue(1, titleFrom + 0.3, duration, "Artist", `${tag("an5", `pos(${g.centreX},${Math.round(top + block + gap + artistHeight / 2)})`, "fad(700,2500)")}${escapeText(layout.artist).toUpperCase()}`);
    }
  }

  // The lyrics: each line appears just before it is sung and goes a little after, but never over the next one.
  const lines = input.lines.filter((line) => line.words.some((word) => escapeText(word.text).length > 0)).sort((a, b) => a.start - b.start);
  // Two lines on the screen at once would be pushed apart by the renderer, so each comes down before the next goes up.
  let free = 0;
  lines.forEach((line, i) => {
    const next = lines[i + 1];
    const from = Math.max(0, line.start - 0.15, free);
    let to = Math.min(duration, line.end + 0.6);
    // Short lines stay up long enough to read, unless the next one needs the room.
    if (to - from < 1.2) to = from + 1.2;
    const nextFrom = next ? Math.max(next.start - 0.15, from + 0.3) : duration;
    to = Math.min(to, nextFrom - 0.02, duration);
    if (to <= from + 0.05) return;
    free = to + 0.02;
    const words = line.words.map((word) => escapeText(word.text)).filter((word) => word.length > 0);
    const fit = fitLyric(words, g.width, g.height);
    const size = fit.size !== lyricBase ? tag(`fs${fit.size}`) : "";
    dialogue(0, from, to, "Lyric", `${tag("fad(150,250)")}${size}${karaokeText(line, from, fit)}`);
  });

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${g.width}`,
    `PlayResY: ${g.height}`,
    // No automatic wrapping: the rows are broken at the words fitLyric chose, and nowhere else.
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    ""
  ].join("\n");
}
