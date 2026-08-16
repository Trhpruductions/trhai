import test from "node:test";
import assert from "node:assert/strict";
import {
  extensionOf,
  isTextFileName,
  looksBinary,
  maxImportBytes,
  maxImportChars,
  prepareImport,
  summarizeImport,
  titleFromFileName,
  type ImportResult
} from "../src/knowledgeImport.js";

test("a file name yields a readable title", () => {
  assert.equal(titleFromFileName("ops-runbook_v2.md"), "Ops Runbook V2");
  assert.equal(titleFromFileName("teamHandbook.txt"), "Team Handbook");
  assert.equal(titleFromFileName("/home/me/notes/DEPLOY.md"), "DEPLOY");
  assert.equal(titleFromFileName("C:\\docs\\release notes.txt"), "Release Notes");
  // An acronym keeps its case rather than becoming "Api".
  assert.equal(titleFromFileName("API.md"), "API");
});

test("a file with no usable name still gets a title", () => {
  assert.equal(titleFromFileName(".md"), ".md");
  assert.equal(titleFromFileName(""), "Untitled");
});

test("text formats are recognized and others refused by name", () => {
  assert.equal(extensionOf("notes.MD"), "md");
  assert.equal(isTextFileName("notes.md"), true);
  assert.equal(isTextFileName("config.yaml"), true);
  assert.equal(isTextFileName("server.ts"), true);

  assert.equal(isTextFileName("scan.pdf"), false);
  assert.equal(isTextFileName("photo.png"), false);
  assert.equal(isTextFileName("archive.zip"), false);
  assert.equal(isTextFileName("README"), false);
});

test("ordinary prose is not mistaken for binary", () => {
  // The check must not trip on spaces, punctuation, tabs or newlines — an
  // over-eager binary test would reject every real document.
  assert.equal(looksBinary("The database is Postgres 16.\n\n\tIndented — and dashed."), false);
  assert.equal(looksBinary("Ünïcödé and emoji 🎉 are fine"), false);
  assert.equal(looksBinary(""), false);
});

test("binary content is detected", () => {
  assert.equal(looksBinary(`PK${String.fromCharCode(3)}${String.fromCharCode(4)}`), true);
  assert.equal(looksBinary(`text${String.fromCharCode(0)}more`), true);
});

test("a file decoded with the wrong encoding is detected", () => {
  const mojibake = String.fromCharCode(0xfffd).repeat(20);

  assert.equal(looksBinary(mojibake), true);
  // A stray replacement character in a long, otherwise clean document is fine.
  assert.equal(looksBinary(`${"a".repeat(5000)}${String.fromCharCode(0xfffd)}`), false);
});

test("a text file is accepted with a title and body", () => {
  const result = prepareImport("ops-runbook.md", "  The database is Postgres 16.  ", 100);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.title, "Ops Runbook");
  assert.equal(result.body, "The database is Postgres 16.");
  assert.equal(result.truncated, false);
});

test("an oversized file is refused before it is read into the store", () => {
  const result = prepareImport("huge.md", "text", maxImportBytes + 1);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /too large/i);
});

test("a long file is trimmed and says so", () => {
  // Silent truncation is the failure to avoid: the user believes the whole
  // document is searchable when half of it was dropped.
  const result = prepareImport("long.md", "x".repeat(maxImportChars + 500), 30000);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body.length, maxImportChars);
  assert.equal(result.truncated, true);
});

test("a PDF is refused by name and says what it was", () => {
  const result = prepareImport("scan.pdf", "%PDF-1.7", 500);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /\.pdf file, which cannot be read as text/);
});

test("a file with a text extension but binary content is still refused", () => {
  const result = prepareImport("sneaky.txt", `ok${String.fromCharCode(0)}binary`, 500);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /does not appear to be text/);
});

test("an empty file is refused", () => {
  const result = prepareImport("blank.md", "   \n  ", 10);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /empty/);
});

test("a partial import is never summarised as a clean one", () => {
  const results: ImportResult[] = [
    { ok: true, title: "One", body: "a", truncated: false },
    { ok: true, title: "Two", body: "b", truncated: true },
    { ok: false, reason: "scan.pdf is a .pdf file, which cannot be read as text." }
  ];

  const summary = summarizeImport(results);
  assert.match(summary, /Imported 2 files/);
  assert.match(summary, /1 trimmed to fit/);
  assert.match(summary, /1 skipped/);
});

test("when everything was rejected the reason is shown, not a count", () => {
  const summary = summarizeImport([{ ok: false, reason: "scan.pdf cannot be read as text." }]);

  assert.equal(summary, "scan.pdf cannot be read as text.");
  assert.doesNotMatch(summary, /Imported/);
});

test("a clean single import reads naturally", () => {
  assert.equal(
    summarizeImport([{ ok: true, title: "One", body: "a", truncated: false }]),
    "Imported 1 file"
  );
});
