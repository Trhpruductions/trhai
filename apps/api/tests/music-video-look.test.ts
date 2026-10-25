import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { crc32, encodePng } from "../src/services/png.js";
import {
  assColour, barsHigh, barsWide, choosePalette, circleMask, controlBarRows, controlHeight, controlWidth, dustLayer, discMask, geometryFor,
  hex, hueExpression, palettes, radialMaps, titleLayout, writeControlFrame
} from "../src/services/musicVideoLook.js";

// A reader for the pictures this module writes (filter type 0, one channel), so that
// what ffmpeg will be given can be looked at pixel by pixel.
function readPng(file: Buffer): { width: number; height: number; depth: number; at: (x: number, y: number) => number } {
  assert.deepEqual([...file.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "a PNG signature");
  const width = file.readUInt32BE(16);
  const height = file.readUInt32BE(20);
  const depth = file[24];
  let offset = 8;
  const idat: Buffer[] = [];
  while (offset < file.length) {
    const size = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + size);
    assert.equal(file.readUInt32BE(offset + 8 + size), crc32(file.subarray(offset + 4, offset + 8 + size)), `${type} checksum`);
    if (type === "IDAT") idat.push(body);
    offset += 12 + size;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const row = (width * depth) / 8 + 1;
  return { width, height, depth, at: (x, y) => (depth === 16 ? raw.readUInt16BE(y * row + 1 + x * 2) : raw[y * row + 1 + x]) };
}

test("the checksum PNG files carry is the standard one, and a picture's size is checked", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const png = readPng(encodePng(3, 2, new Uint8Array([0, 50, 100, 150, 200, 255]), "gray8"));
  assert.deepEqual([png.width, png.height, png.depth], [3, 2, 8]);
  assert.deepEqual([png.at(0, 0), png.at(2, 0), png.at(0, 1), png.at(1, 1), png.at(2, 1)], [0, 100, 150, 200, 255]);
  const sixteen = readPng(encodePng(2, 1, new Uint16Array([0, 65535]), "gray16"));
  assert.deepEqual([sixteen.depth, sixteen.at(0, 0), sixteen.at(1, 0)], [16, 0, 65535]);
  assert.throws(() => encodePng(4, 4, new Uint8Array(10), "gray8"), /holds 16 values, not 10/);
  assert.throws(() => encodePng(0, 4, new Uint8Array(0), "gray8"), /positive/);
});

test("the ring sits above the middle of a 16 by 9 frame, with room for lyrics below it", () => {
  for (const height of [720, 1080] as const) {
    const g = geometryFor(height);
    assert.equal(g.width % 2, 0);
    assert.ok(Math.abs(g.width / g.height - 16 / 9) < 0.01, "16 by 9");
    assert.ok(g.inner < g.outer && g.outer < g.height * 0.45, "the ring is inside the frame");
    assert.ok(g.centreY + g.outer <= g.height * 0.8 + 1, "the longest bar stops above the lyrics, which two rows of take the bottom fifth");
    assert.ok(g.centreY - g.outer >= g.height * 0.03 - 1, "with a margin above the ring");
    assert.ok(g.centreY - g.outer > 0, "and below the top of the frame");
  }
});

test("the ring's maps send each pixel to the right bar and height", () => {
  const g = geometryFor(720);
  const maps = radialMaps(g);
  const x = readPng(maps.x);
  const y = readPng(maps.y);
  assert.deepEqual([x.width, x.height, x.depth], [g.width, g.height, 16]);
  const mid = Math.round((g.inner + g.outer) / 2);
  // Straight below the centre is the lowest note, at the bottom of the bars; straight above, the highest.
  assert.equal(x.at(g.centreX, g.centreY + mid), 0);
  assert.equal(x.at(g.centreX, g.centreY - mid), barsWide - 1);
  assert.ok(Math.abs(x.at(g.centreX + mid, g.centreY) - (barsWide - 1) / 2) <= 1, "level with the centre is halfway");
  // Mirrored: the same distance left and right gives the same bar.
  for (const [dx, dy] of [[40, 150], [200, -90], [-130, 200]]) assert.equal(x.at(g.centreX + dx, g.centreY + dy), x.at(g.centreX - dx, g.centreY + dy));
  // Height: the baseline row at the inner radius, the top row at the outer one, and nothing outside.
  assert.equal(y.at(g.centreX, g.centreY + g.inner + 1), barsHigh - 1 - Math.round(((1 / (g.outer - g.inner)) * (barsHigh - 1))));
  assert.ok(y.at(g.centreX, g.centreY + g.outer) <= 1, "the outer edge is the top of the bars");
  assert.equal(y.at(g.centreX, g.centreY + g.outer + 5), 65535);
  assert.equal(y.at(g.centreX, g.centreY + g.inner - 5), 65535);
  assert.equal(y.at(0, 0), 65535);
});

test("the disc is dark inside the ring and untouched everywhere else", () => {
  const g = geometryFor(720);
  const disc = readPng(discMask(g));
  assert.equal(disc.at(g.centreX, g.centreY), 32);
  assert.equal(disc.at(g.centreX + g.inner - 20, g.centreY), 32);
  assert.equal(disc.at(g.centreX + g.inner + 40, g.centreY), 255);
  assert.equal(disc.at(5, 5), 255);
  const circle = readPng(circleMask(g, 100));
  assert.deepEqual([circle.at(g.centreX, g.centreY), circle.at(g.centreX + 99, g.centreY), circle.at(g.centreX + 102, g.centreY)], [255, 255, 0]);
});

test("the dust is the same in both halves, so that it scrolls without a seam, and is sparse", () => {
  const g = geometryFor(720);
  const dust = readPng(dustLayer(g));
  assert.equal(dust.height, g.height * 2);
  let lit = 0;
  for (let row = 0; row < g.height; row += 17) {
    for (let col = 0; col < g.width; col += 1) {
      assert.equal(dust.at(col, row), dust.at(col, row + g.height), `row ${row} column ${col}`);
      if (dust.at(col, row) > 0) lit += 1;
    }
  }
  const sampled = Math.ceil(g.height / 17) * g.width;
  assert.ok(lit / sampled > 0.0004 && lit / sampled < 0.004, `${lit} of ${sampled} sampled pixels lit`);
  assert.deepEqual(dustLayer(g, 12), dustLayer(g, 12), "the same seed gives the same dust");
  assert.notDeepEqual(dustLayer(g, 12), dustLayer(g, 13));
});

test("a control frame has the bars standing from the bottom, and the glow across the last rows", () => {
  const frame = new Uint8Array(controlWidth * controlHeight);
  const levels = new Uint8Array(64).fill(0);
  levels[0] = 255;
  levels[1] = 128;
  levels[2] = 0;
  writeControlFrame(frame, levels, 200, 64);
  const column = (k: number) => Array.from({ length: controlBarRows }, (_, row) => frame[row * controlWidth + k]).filter((v) => v === 255).length;
  assert.equal(column(0), controlBarRows - 1);
  assert.ok(Math.abs(column(1) - 110) <= 2, "half level, half height");
  assert.equal(column(2), 1, "a silent bar still shows its base");
  assert.equal(frame[(controlBarRows - 1) * controlWidth + 2], 255, "and the base is at the bottom");
  assert.equal(frame[0 * controlWidth + 0], 0, "above a bar is dark");
  for (let row = controlBarRows; row < controlHeight; row += 1) assert.ok(Array.from({ length: controlWidth }, (_, k) => frame[row * controlWidth + k]).every((v) => v === 200), `glow row ${row}`);
  // The frame is cleared each time: the last frame's bars do not linger.
  writeControlFrame(frame, new Uint8Array(64), 0, 64);
  assert.equal(column(0), 1);
  assert.equal(frame[controlBarRows * controlWidth], 0);
});

test("a title is fitted inside the disc: broken only when that helps, and as big as will fit", () => {
  const disc = 288;
  const short = titleLayout("Rise", "Shadows of Ruin", disc);
  assert.deepEqual(short.lines, ["RISE"]);
  assert.ok(short.titleSize >= 45 && short.titleSize <= Math.round(disc * 0.2), `${short.titleSize}`);
  const two = titleLayout("Neon Highway", "The Test Band", disc);
  assert.deepEqual(two.lines, ["NEON", "HIGHWAY"]);
  const widest = Math.max(...two.lines.map((line) => line.length));
  assert.ok(widest * two.titleSize * 0.7 <= disc * 0.8 + 1, "the widest line fits the disc");
  assert.ok(two.artistSize > 0 && two.artistSize < two.titleSize, "the artist is smaller than the title");
  const long = titleLayout("The Long And Winding Road To Nowhere In Particular", "", disc);
  assert.equal(long.lines.length, 3);
  assert.equal(long.artistSize, 0, "no artist, no artist line");
  assert.equal(long.artist, "");
  assert.deepEqual(titleLayout("   ", "", disc).lines, ["UNTITLED"]);
  assert.equal(titleLayout("One", "", disc).lines.length, 1);
  // A single enormous word is made small rather than allowed to overflow.
  const word = titleLayout("Supercalifragilisticexpialidocious", "", disc);
  assert.deepEqual(word.lines, ["SUPERCALIFRAGILISTICEXPIALIDOCIOUS"]);
});

test("whatever the title and artist, what is set stays inside the disc, shortened with an ellipsis if it must be", () => {
  const disc = 288;
  const inside = (layout: ReturnType<typeof titleLayout>, label: string) => {
    for (const line of layout.lines) assert.ok(line.length * layout.titleSize * 0.7 <= disc * 0.8 + 1, `${label}: "${line}" at ${layout.titleSize} spills out of the disc`);
    assert.ok(layout.titleSize >= 8, `${label}: type no smaller than 8`);
    if (layout.artistSize > 0) assert.ok(layout.artist.length * layout.artistSize * 0.75 <= disc * 0.8 + 1, `${label}: the artist spills out of the disc`);
  };
  const words = ["Neon", "Highway", "Supercalifragilistic", "Ascend", "A", "Of", "Midnight", "Thunderstruck", "Dreams", "Between", "Electric", "Cathedral"];
  let seed = 7;
  const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 300; i += 1) {
    const count = 1 + Math.floor(next() * 14);
    const title = Array.from({ length: count }, () => words[Math.floor(next() * words.length)]).join(" ");
    const artist = Array.from({ length: Math.floor(next() * 9) }, () => words[Math.floor(next() * words.length)]).join(" ");
    inside(titleLayout(title, artist, disc), `${title} / ${artist}`);
  }
  const huge = titleLayout("x".repeat(400), "y".repeat(200), disc);
  inside(huge, "400 letters");
  assert.ok(huge.lines[0].endsWith("…"), "cut with an ellipsis");
  assert.ok(huge.artist.endsWith("…") && huge.artist.length <= 34, "the artist too");
  const big = titleLayout("Rise", "Shadows of Ruin", 432);
  assert.ok(big.titleSize > titleLayout("Rise", "Shadows of Ruin", 288).titleSize, "a bigger disc gets bigger type");
  assert.equal(titleLayout("Rise", "  Shadows   of  Ruin ", disc).artist, "Shadows of Ruin", "spaces are tidied");
});

test("colours: the palette asked for, or one that suits the song, and the two colour notations", () => {
  assert.equal(choosePalette("ice", { bpm: 150, intensity: [1, 1] }).id, "ice");
  assert.equal(choosePalette(undefined, { bpm: 160, intensity: [0.9, 0.8, 0.9] }).id, "ember");
  assert.equal(choosePalette(undefined, { bpm: 72, intensity: [0.3, 0.4] }).id, "ice");
  assert.equal(choosePalette(undefined, { bpm: 120, intensity: [0.6, 0.6] }).id, "neon");
  assert.equal(choosePalette(undefined, { bpm: null, intensity: [] }).id, "neon");
  assert.equal(choosePalette("nonsense", { bpm: 120, intensity: [0.6] }).id, "neon");
  assert.equal(hex(0x4de8ff), "0x4de8ff");
  assert.equal(hex(0x0a0302), "0x0a0302");
  assert.equal(assColour(0x4de8ff), "&H00FFE84D", "ASS wants blue, green, red");
  assert.equal(assColour(0xffffff, 0x80), "&H80FFFFFF");
  assert.equal(new Set(palettes.map((p) => p.id)).size, palettes.length);
});

test("the colour turns a little at each change of section, and not at all for a song with one", () => {
  assert.equal(hueExpression([{ start: 0, kind: "low" }]), "0");
  assert.equal(hueExpression([{ start: 0, kind: "low" }, { start: 20, kind: "low" }]), "0");
  const sections = [{ start: 0, kind: "intro" }, { start: 8, kind: "low" }, { start: 24, kind: "high" }, { start: 40, kind: "low" }];
  const expression = hueExpression(sections);
  const at = (t: number) => new Function("t", "clip", `return ${expression}`)(t, (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))) as number;
  assert.equal(at(0), -14, "the intro starts turned back");
  assert.equal(at(7.9), -14);
  assert.ok(Math.abs(at(9.5) - 0) < 1e-9, "by the verse it is back to straight");
  assert.ok(at(8.75) > -14 && at(8.75) < 0, "and the turn comes in gradually");
  assert.ok(Math.abs(at(26) - 26) < 1e-9, "the loud part is turned forward");
  assert.ok(Math.abs(at(42) - 0) < 1e-9, "and back again");
});
