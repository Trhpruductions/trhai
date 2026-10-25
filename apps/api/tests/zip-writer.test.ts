import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dosDateTime, writeZip } from "../src/services/zipWriter.js";
import { readZip } from "../src/services/documentText.js";

const fixed = new Date(2026, 9, 25, 11, 22, 34);

test("what is written is read back, name for name and byte for byte", () => {
  const big = "the same sentence again and again. ".repeat(400);
  const binary = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) % 256));
  const archive = writeZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "word/document.xml", data: big },
    { name: "media/picture.bin", data: binary },
    { name: "empty.txt", data: "" },
    { name: "ünïcode/日本語.txt", data: "héllo ♪" }
  ], { date: fixed });
  const entries = readZip(archive);
  assert.deepEqual([...entries.keys()], ["[Content_Types].xml", "word/document.xml", "media/picture.bin", "empty.txt", "ünïcode/日本語.txt"]);
  assert.equal(entries.get("[Content_Types].xml")!().toString(), "<Types/>");
  assert.equal(entries.get("word/document.xml")!().toString(), big);
  assert.deepEqual(entries.get("media/picture.bin")!(), binary);
  assert.equal(entries.get("empty.txt")!().length, 0);
  assert.equal(entries.get("ünïcode/日本語.txt")!().toString(), "héllo ♪");
});

test("what compresses is compressed, and what would not shrink is stored as it is", () => {
  const text = "abc ".repeat(2000);
  // Random bytes come out of deflate larger than they went in: those are kept as they are.
  const random = randomBytes(400);
  const archive = writeZip([{ name: "a.txt", data: text }, { name: "b.txt", data: "tiny" }, { name: "c.bin", data: random }], { date: fixed });
  assert.ok(archive.length < text.length / 5 + 600, `${archive.length} bytes for ${text.length} of repeated text and 400 that cannot shrink`);
  // The method of each entry: 8 deflated, 0 stored, read from the central directory.
  const methods: number[] = [];
  for (let at = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); at >= 0 && at < archive.length - 22; at = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 4)) methods.push(archive.readUInt16LE(at + 10));
  assert.deepEqual(methods, [8, 0, 0]);
  assert.deepEqual(readZip(archive).get("c.bin")!(), random, "and stored, they come back the same");
});

test("names are marked as UTF-8, and the counts at the end agree with the files in the archive", () => {
  const archive = writeZip([{ name: "ünï.txt", data: "a" }, { name: "b.txt", data: "b" }], { date: fixed });
  assert.equal(archive.readUInt16LE(6) & 0x0800, 0x0800, "the first file's own header says its name is UTF-8");
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.equal(archive.readUInt16LE(central + 8) & 0x0800, 0x0800, "and so does the directory's entry for it");
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  assert.equal(archive.readUInt16LE(end + 8), 2, "entries on this disk");
  assert.equal(archive.readUInt16LE(end + 10), 2, "entries in all");
});

test("the same files on the same date make the same archive", () => {
  const files = [{ name: "a.xml", data: "<a>1</a>".repeat(50) }, { name: "b.xml", data: "<b/>" }];
  assert.deepEqual(writeZip(files, { date: fixed }), writeZip(files, { date: fixed }));
  assert.notDeepEqual(writeZip(files, { date: fixed }), writeZip(files, { date: new Date(2026, 9, 26, 1, 2, 4) }));
});

test("the date is written the way zip wants it", () => {
  assert.deepEqual(dosDateTime(fixed), { date: ((2026 - 1980) << 9) | (10 << 5) | 25, time: (11 << 11) | (22 << 5) | 17 });
  assert.equal(dosDateTime(new Date(1970, 0, 1)).date >> 9, 0, "no year before 1980 can be written; 1980 is");
});

test("an archive that cannot be written right is refused, not written wrong", () => {
  assert.throws(() => writeZip([{ name: "a", data: "1" }, { name: "a", data: "2" }]), /twice/);
  assert.throws(() => writeZip([{ name: "", data: "1" }]), /cannot be put in an archive/);
  assert.throws(() => writeZip([{ name: "x".repeat(70_000), data: "1" }]), /cannot be put in an archive/);
  assert.equal(readZip(writeZip([])).size, 0, "an empty archive is still an archive");
});

// A reader that is not ours: Windows 10 and later ship bsdtar, which lists and extracts zip files. (Not any tar on the PATH: Git's is
// GNU tar, which reads no zip files.)
const bsdtar = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe");
test("another program's zip reader opens it too", { skip: existsSync(bsdtar) ? false : "no bsdtar here" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trhai-zip-"));
  try {
    const file = path.join(dir, "made.zip");
    writeFileSync(file, writeZip([{ name: "word/document.xml", data: "<w:document>".repeat(100) }, { name: "docProps/app.xml", data: "<x/>" }], { date: fixed }));
    const listed = spawnSync(bsdtar, ["-tf", file], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.split(/\r?\n/).filter(Boolean), ["word/document.xml", "docProps/app.xml"]);
    const extracted = spawnSync(bsdtar, ["-xOf", file, "word/document.xml"], { encoding: "utf8" });
    assert.equal(extracted.status, 0, extracted.stderr);
    assert.equal(extracted.stdout, "<w:document>".repeat(100));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
