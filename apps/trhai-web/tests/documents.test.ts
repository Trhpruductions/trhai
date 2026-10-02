import test from "node:test";
import assert from "node:assert/strict";
import { describeImport, describeLength, maxImportBytes, refuseBeforeSending } from "../src/lib/documents.js";

test("a document's length reads as words, the way a person thinks of it", () => {
  assert.equal(describeLength(30), "about 5 words");
  assert.equal(describeLength(5_000), "about 833 words");
  assert.equal(describeLength(12_000), "about 2k words");
  assert.equal(describeLength(15_000), "about 2.5k words");
  assert.equal(describeLength(120_000), "about 20k words");
});

test("an added file is described by what it was and how much of it there is", () => {
  const document = { id: "d", title: "Q3 report", createdAt: "2026-10-01T00:00:00.000Z", characters: 6000 };
  assert.equal(describeImport({ document, kind: "pdf", pages: 2, truncated: false }), 'Added "Q3 report" (PDF, 2 pages, about 1k words).');
  assert.equal(describeImport({ document, kind: "pptx", pages: 1, truncated: false }), 'Added "Q3 report" (presentation, 1 slide, about 1k words).');
  assert.match(describeImport({ document, kind: "docx", truncated: true }), /only the first part was kept/);
});

test("a file that cannot be read is turned away before it is sent", () => {
  assert.equal(refuseBeforeSending({ name: "report.pdf", size: 1024 }), null);
  assert.equal(refuseBeforeSending({ name: "Notes.MD", size: 10 }), null);
  assert.match(refuseBeforeSending({ name: "photo.jpg", size: 10 }) ?? "", /not a kind of document/);
  assert.match(refuseBeforeSending({ name: "old.doc", size: 10 }) ?? "", /\.docx/, "the old Word format is named so the user knows to re-save");
  assert.match(refuseBeforeSending({ name: "empty.txt", size: 0 }) ?? "", /empty/);
  assert.match(refuseBeforeSending({ name: "huge.pdf", size: maxImportBytes + 1 }) ?? "", /up to 40 MB/);
});
