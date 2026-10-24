// How a music video looks: its colours, where the ring sits, the pictures
// ffmpeg is given to build it from, and the numbers that move it.
//
// The picture is a ring of spectrum bars around a dark disc that holds the
// title, over a dark gradient with slowly drifting dust, with the lyrics below.
// ffmpeg draws it from three small things made here: a control video (the bar
// heights and a glow level for every frame, from audioAnalysis.ts), a pair of
// coordinate maps that bend a straight row of bars into a ring, and a few
// stills. Nothing here touches the disk or runs a program, so all of it is tested.

import type { Analysis } from "./audioAnalysis.js";
import { encodePng } from "./png.js";

// ---------------------------------------------------------------- geometry

export type Geometry = {
  width: number;
  height: number;
  centreX: number;
  centreY: number;
  /** Radius of the dark disc's edge, where the bars start, in pixels. */
  inner: number;
  /** Radius the longest bar reaches. */
  outer: number;
};

/** Where bars come from: the picture the bars are drawn into before being bent into a ring. */
export const barsWide = 512;
export const barsHigh = 220;
/** The control video carries one column per bar, bars above, then a few rows of glow. */
export const controlWidth = 64;
export const controlBarRows = 220;
export const controlGlowRows = 8;
export const controlHeight = controlBarRows + controlGlowRows;

export function geometryFor(height: 720 | 1080): Geometry {
  const width = Math.round((height * 16) / 9 / 2) * 2;
  // The ring sits a little above the middle so the lyrics have the bottom to themselves.
  return { width, height, centreX: width / 2, centreY: Math.round(height * 0.43), inner: Math.round(height * 0.2), outer: Math.round(height * 0.4) };
}

// ---------------------------------------------------------------- colours

export type Palette = {
  id: string;
  label: string;
  /** Three colours the background drifts between, darkest first, as 0xRRGGBB. */
  background: [number, number, number];
  /** The bars run from this colour at the top of the ring to the other at the bottom. */
  barsTop: number;
  barsBottom: number;
  /** The glow on a beat, as red, green and blue gains. */
  glow: [number, number, number];
  /** Lyrics: the word being sung and the words still to come, as 0xRRGGBB. */
  sung: number;
  unsung: number;
};

export const palettes: Palette[] = [
  { id: "neon", label: "Neon", background: [0x03020b, 0x0c0722, 0x190a30], barsTop: 0x4de8ff, barsBottom: 0xff2fa8, glow: [0.16, 0.07, 0.26], sung: 0x4de8ff, unsung: 0xffffff },
  { id: "ember", label: "Ember", background: [0x0a0302, 0x1a0705, 0x2b0c06], barsTop: 0xffd166, barsBottom: 0xff3b1f, glow: [0.3, 0.1, 0.03], sung: 0xffb347, unsung: 0xffffff },
  { id: "ice", label: "Ice", background: [0x020611, 0x07142b, 0x0b2340], barsTop: 0xd6f7ff, barsBottom: 0x4d8dff, glow: [0.06, 0.16, 0.3], sung: 0x9fe7ff, unsung: 0xffffff },
  { id: "sunset", label: "Sunset", background: [0x0d0508, 0x2a0b1a, 0x40122a], barsTop: 0xffd36e, barsBottom: 0xff5e8a, glow: [0.3, 0.12, 0.12], sung: 0xffd36e, unsung: 0xffffff },
  { id: "mono", label: "Mono", background: [0x050505, 0x101010, 0x1c1c1c], barsTop: 0xffffff, barsBottom: 0x8a8a8a, glow: [0.18, 0.18, 0.18], sung: 0xffffff, unsung: 0xb8b8b8 }
];

/** The palette asked for, or one that suits the song: fast and loud is ember, slow is ice, the rest neon. */
export function choosePalette(id: string | undefined, analysis: Pick<Analysis, "bpm" | "intensity">): Palette {
  const asked = palettes.find((palette) => palette.id === id);
  if (asked) return asked;
  const energy = analysis.intensity.length ? analysis.intensity.reduce((a, b) => a + b, 0) / analysis.intensity.length : 0;
  if (analysis.bpm !== null && analysis.bpm >= 138 && energy > 0.5) return palettes[1];
  if (analysis.bpm !== null && analysis.bpm < 90) return palettes[2];
  return palettes[0];
}

export const hex = (rgb: number) => `0x${rgb.toString(16).padStart(6, "0")}`;
/** ASS colours are &HAABBGGRR, with the alpha first and the colours backwards. */
export const assColour = (rgb: number, alpha = 0) => `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${(((rgb & 0xff) << 16) | (rgb & 0xff00) | (rgb >> 16)).toString(16).padStart(6, "0").toUpperCase()}`;

// ---------------------------------------------------------------- the sections' colour shifts

/**
 * The hue to turn the picture by, in degrees, as an ffmpeg expression of the
 * time t: a gentle turn that comes in over a second and a half at each change
 * of section, so that the loud parts look a little different from the quiet ones.
 * "0" when there is nothing to turn.
 */
export function hueExpression(sections: Array<{ start: number; kind: string }>): string {
  const turnFor = (kind: string) => (kind === "high" ? 26 : kind === "intro" || kind === "outro" ? -14 : 0);
  const steps: string[] = [];
  for (let i = 1; i < sections.length; i += 1) {
    const change = turnFor(sections[i].kind) - turnFor(sections[i - 1].kind);
    if (change !== 0) steps.push(`${change}*clip((t-${sections[i].start.toFixed(2)})/1.5,0,1)`);
  }
  if (steps.length === 0) return "0";
  return [String(turnFor(sections[0]?.kind ?? "low")), ...steps].join("+");
}

// ---------------------------------------------------------------- the pictures

/** A tiny seeded generator, so that the same song always has the same dust. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * The two maps that bend the bars into a ring, as 16-bit gray pictures. For
 * each pixel of the video they say which pixel of the bar picture to show: how
 * far round the ring decides the bar (low notes at the bottom, mirrored left
 * and right) and how far out decides the height.
 */
export function radialMaps(g: Geometry): { x: Buffer; y: Buffer } {
  const xs = new Uint16Array(g.width * g.height);
  const ys = new Uint16Array(g.width * g.height);
  for (let y = 0; y < g.height; y += 1) {
    for (let x = 0; x < g.width; x += 1) {
      const dx = x - g.centreX;
      const dy = y - g.centreY;
      const r = Math.hypot(dx, dy);
      const index = y * g.width + x;
      const angle = Math.atan2(Math.abs(dx), dy); // 0 straight down, pi straight up
      xs[index] = Math.max(0, Math.min(barsWide - 1, Math.round((angle / Math.PI) * (barsWide - 1))));
      // A value past the bar picture's height is shown as black: nothing is drawn outside the ring.
      ys[index] = r >= g.inner && r <= g.outer ? Math.round(barsHigh - 1 - ((r - g.inner) / (g.outer - g.inner)) * (barsHigh - 1)) : 65535;
    }
  }
  return { x: encodePng(g.width, g.height, xs, "gray16"), y: encodePng(g.width, g.height, ys, "gray16") };
}

/** Multiplied over the picture: the disc inside the ring is dark, with a soft edge, and everything else is untouched. */
export function discMask(g: Geometry): Buffer {
  const pixels = new Uint8Array(g.width * g.height);
  const edge = g.inner - Math.round(g.height / 80);
  for (let y = 0; y < g.height; y += 1) {
    for (let x = 0; x < g.width; x += 1) {
      const r = Math.hypot(x - g.centreX, y - g.centreY);
      pixels[y * g.width + x] = Math.round(Math.max(32, Math.min(255, 32 + (r - edge) * 28)));
    }
  }
  return encodePng(g.width, g.height, pixels, "gray8");
}

/** Light inside a circle of this radius and nothing outside it, for cutting a picture to a disc. */
export function circleMask(g: Geometry, radius: number): Buffer {
  const pixels = new Uint8Array(g.width * g.height);
  for (let y = 0; y < g.height; y += 1) {
    for (let x = 0; x < g.width; x += 1) {
      const r = Math.hypot(x - g.centreX, y - g.centreY);
      pixels[y * g.width + x] = Math.round(Math.max(0, Math.min(255, (radius - r) * 255)));
    }
  }
  return encodePng(g.width, g.height, pixels, "gray8");
}

/**
 * Sparse specks of dust, twice as tall as the picture and the same pattern in
 * both halves, so that scrolling it up by one picture height lands exactly
 * where it started and the loop has no seam.
 */
export function dustLayer(g: Geometry, seed = 12): Buffer {
  const random = seeded(seed);
  const pixels = new Uint8Array(g.width * g.height * 2);
  const density = 0.0009;
  for (let y = 0; y < g.height; y += 1) {
    for (let x = 0; x < g.width; x += 1) {
      if (random() >= density) continue;
      const brightness = Math.round(150 + random() * 105);
      for (const [ox, oy, share] of [[0, 0, 1], [1, 0, 0.45], [0, 1, 0.45]] as const) {
        const px = x + ox;
        const py = (y + oy) % g.height;
        if (px >= g.width) continue;
        for (const row of [py, py + g.height]) pixels[row * g.width + px] = Math.max(pixels[row * g.width + px], Math.round(brightness * share));
      }
    }
  }
  return encodePng(g.width, g.height * 2, pixels, "gray8");
}

// ---------------------------------------------------------------- the control video

/** Writes one frame of the control video: the bars drawn from the bottom, then the glow across a few rows. */
export function writeControlFrame(into: Uint8Array, levels: Uint8Array, light: number, bands: number): void {
  into.fill(0);
  for (let k = 0; k < Math.min(bands, controlWidth); k += 1) {
    const height = Math.max(1, Math.round((levels[k] / 255) * (controlBarRows - 1)));
    for (let row = controlBarRows - height; row < controlBarRows; row += 1) into[row * controlWidth + k] = 255;
  }
  for (let row = controlBarRows; row < controlHeight; row += 1) into.fill(light, row * controlWidth, (row + 1) * controlWidth);
}

// ---------------------------------------------------------------- the title in the disc

/** `artist` is the line to set, shortened if it had to be; `artistSize` is 0 when there is none. */
export type TitleLayout = { lines: string[]; titleSize: number; artist: string; artistSize: number };

/**
 * The title, in capitals, broken into as few lines as will fit inside the
 * disc, at the largest size that fits; the artist smaller beneath. A width in
 * capitals of this kind of typeface is about 0.7 of its size, with the
 * letter-spacing the title is set with.
 */
export function titleLayout(title: string, artist: string, discDiameter: number): TitleLayout {
  const available = discDiameter * 0.8;
  // Whatever is given has to fit the disc, so a line is cut, with an ellipsis, rather than set in type too small to read.
  const smallest = 8;
  const longest = Math.floor(available / (smallest * 0.7));
  const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`);
  const text = clip(title.trim().toUpperCase().replace(/\s+/g, " "), longest * 2) || "UNTITLED";
  const widest = (lines: string[]) => Math.max(...lines.map((line) => line.length));
  const sizeFor = (lines: string[]) => Math.min(available / (widest(lines) * 0.7), discDiameter * 0.17 / (lines.length > 1 ? 1 : 0.85));
  const words = text.split(" ").map((word) => clip(word, longest));
  const options: string[][] = [[words.join(" ")]];
  for (let cut = 1; cut < words.length; cut += 1) options.push([words.slice(0, cut).join(" "), words.slice(cut).join(" ")]);
  if (words.length >= 3) {
    for (let a = 1; a < words.length - 1; a += 1) for (let b = a + 1; b < words.length; b += 1) options.push([words.slice(0, a).join(" "), words.slice(a, b).join(" "), words.slice(b).join(" ")]);
  }
  // The biggest type wins, with a small penalty for every extra line, so that a title only breaks when that helps.
  const score = (lines: string[]) => sizeFor(lines) * (1 - 0.06 * (lines.length - 1));
  let best = options[0];
  for (const option of options) if (score(option) > score(best)) best = option;
  best = best.map((line) => clip(line, longest));
  const titleSize = Math.max(smallest, Math.floor(sizeFor(best)));
  // The artist is set in a line of at most 34 letters, which at the smallest size still fits the disc.
  const artistText = clip(artist.trim().replace(/\s+/g, " "), 34);
  return { lines: best, titleSize, artist: artistText, artistSize: artistText ? Math.max(9, Math.floor(Math.min(titleSize * 0.5, (available / (artistText.length * 0.75)) * 0.9))) : 0 };
}
