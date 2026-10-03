import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

// The app's fonts come from files in this repo, so building it needs no
// network. They used to come through next/font/google, which downloads them
// from Google whenever the app is built, or run in development, with no cached
// copy of them - on the build server, every time. On 3 October that download
// failed there twice - once in the build, once in the desktop shell's
// dev-server test - and each time the whole check failed for a change that
// had nothing to do with fonts. A PC with no connection could not make a
// first build at all.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fontsDir = path.join(root, "public", "fonts");
const css = readFileSync(path.join(root, "src", "app", "fonts.css"), "utf8");
const layout = readFileSync(path.join(root, "src", "app", "layout.tsx"), "utf8");

/** Every source file under src, as text. */
function sources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(?:tsx?|css|mjs)$/.test(entry.name) ? [{ file: full, text: readFileSync(full, "utf8") }] : [];
  });
}

test("nothing in the app fetches a font from the network", () => {
  for (const { file, text } of sources(path.join(root, "src"))) {
    assert.doesNotMatch(text, /from\s+["']next\/font\/google["']/, `${file} loads a font through Google's loader`);
    assert.doesNotMatch(text, /url\(\s*["']?https?:/i, `${file} points a url() at the network`);
    assert.doesNotMatch(text, /fonts\.(?:googleapis|gstatic)\.com/, `${file} names Google's font servers`);
  }
});

test("every font the stylesheet names is a file in the repo, and every file is used", () => {
  const named = [...css.matchAll(/url\("\/fonts\/([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(named.length >= 14, `the stylesheet names ${named.length} files`);
  for (const name of named) {
    const file = path.join(fontsDir, name);
    assert.ok(existsSync(file), `${name} is named in fonts.css and is not in public/fonts`);
    // A real WOFF2 file, not a placeholder or an error page saved under its name.
    assert.equal(readFileSync(file).subarray(0, 4).toString("latin1"), "wOF2", `${name} is not a WOFF2 font`);
    assert.ok(statSync(file).size > 4000, `${name} is only ${statSync(file).size} bytes`);
  }
  const onDisk = readdirSync(fontsDir).filter((name) => name.endsWith(".woff2")).sort();
  assert.deepEqual(onDisk, [...new Set(named)].sort(), "the files in public/fonts are exactly the ones the stylesheet uses");
});

test("each face has its characters, its fallback and its variable", () => {
  for (const [family, variable] of [["Geist", "--font-geist-sans"], ["Geist Mono", "--font-geist-mono"], ["Orbitron", "--font-orbitron"], ["Oxanium", "--font-oxanium"]]) {
    const faces = [...css.matchAll(/@font-face \{([^}]*)\}/g)].map((match) => match[1]).filter((body) => body.includes(`font-family: "${family}";`));
    assert.ok(faces.length > 0, `${family} has no face`);
    // The Latin file is the one every page needs: plain letters and punctuation.
    assert.ok(faces.some((body) => body.includes("U+0000-00FF")), `${family} has no file for plain Latin text`);
    for (const body of faces) assert.match(body, /font-display: swap;/, `${family} must show its fallback while it loads`);
    // The fallback is sized to match, so text does not jump when the font arrives.
    assert.match(css, new RegExp(`font-family: "${family} Fallback";[^}]*size-adjust: [\\d.]+%;`), `${family} has no adjusted fallback`);
    assert.ok(css.includes(`${variable}: "${family}", "${family} Fallback";`), `${variable} is not set to ${family}`);
  }
});

test("the files a page needs at once are asked for at once", () => {
  const preloaded = /const preloadedFonts = \[([^\]]+)\]/.exec(layout)?.[1].match(/[\w-]+/g) ?? [];
  assert.deepEqual(preloaded, ["geist-latin", "geist-mono-latin", "orbitron-latin", "oxanium-latin"]);
  for (const name of preloaded) assert.ok(existsSync(path.join(fontsDir, `${name}.woff2`)), `${name}.woff2 is preloaded and is not in public/fonts`);
  // A font preload without crossOrigin is fetched twice: once for the preload, once for the stylesheet.
  assert.match(layout, /rel="preload" href=\{`\/fonts\/\$\{name\}\.woff2`\} as="font" type="font\/woff2" crossOrigin="anonymous"/);
});

/**
 * What a WOFF2 font says about itself: the strings in its naming table, by
 * their number (0 is its copyright notice, 14 the address of its licence).
 */
function namesIn(file: string): Map<number, string> {
  const data = readFileSync(file);
  let at = 48; // past the header, where the list of tables begins
  // A number stored seven bits to a byte; the top bit says another byte follows.
  const number = (): number => {
    let value = 0;
    for (;;) {
      const byte = data[at++];
      value = value * 128 + (byte & 0x7f);
      if (byte < 0x80) return value;
    }
  };
  const listed: Array<{ kind: number; stored: number }> = [];
  for (let left = data.readUInt16BE(12); left > 0; left -= 1) {
    const flags = data[at++];
    const kind = flags & 0x3f;
    if (kind === 63) at += 4; // a table outside the format's own list is named in full
    const size = number();
    // The two glyph tables (10 and 11) are stored reshaped when marked 0; any other table when marked anything else.
    const reshaped = kind === 10 || kind === 11 ? flags >> 6 === 0 : flags >> 6 !== 0;
    listed.push({ kind, stored: reshaped ? number() : size });
  }
  const naming = listed.findIndex((table) => table.kind === 5);
  assert.ok(naming >= 0, `${file} has no naming table`);
  // The tables are packed together, one after another in the order listed.
  const tables = brotliDecompressSync(data.subarray(at, at + data.readUInt32BE(20)));
  const table = tables.subarray(listed.slice(0, naming).reduce((sum, earlier) => sum + earlier.stored, 0));
  const strings = table.readUInt16BE(4);
  const names = new Map<number, string>();
  for (let i = 0; i < table.readUInt16BE(2); i += 1) {
    const record = 6 + i * 12;
    // Platform 3 is the one a web font is read by; its text is two bytes a character, high byte first.
    if (table.readUInt16BE(record) !== 3) continue;
    const from = strings + table.readUInt16BE(record + 10);
    const text = Buffer.from(table.subarray(from, from + table.readUInt16BE(record + 8)));
    names.set(table.readUInt16BE(record + 6), text.swap16().toString("utf16le"));
  }
  return names;
}

test("the notice beside the fonts carries what each file says of its copyright and licence", () => {
  // The licence these fonts are published under asks that their copyright
  // notice goes wherever they go. Read from the files, not typed twice: a font
  // added without its notice, or a notice shortened by hand, fails here.
  const notice = readFileSync(path.join(fontsDir, "NOTICE.txt"), "utf8");
  for (const file of readdirSync(fontsDir).filter((name) => name.endsWith(".woff2"))) {
    const names = namesIn(path.join(fontsDir, file));
    const copyright = names.get(0);
    const licence = names.get(14);
    assert.ok(copyright, `${file} states no copyright notice`);
    assert.ok(licence, `${file} gives no address for its licence`);
    assert.ok(notice.includes(file), `${file} is not listed in NOTICE.txt`);
    assert.ok(notice.includes(copyright), `NOTICE.txt does not carry the copyright notice in ${file}: ${copyright}`);
    assert.ok(notice.includes(`Licence: ${licence}`), `NOTICE.txt does not give the licence address in ${file}: ${licence}`);
  }
});
