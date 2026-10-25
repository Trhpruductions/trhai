import test from "node:test";
import assert from "node:assert/strict";
import { absolutePath, canOpenInProgram, crumbs, fileKind, formatBytes, languageOf, madeFilesFrom, madeFilesInText, parentOf, readableDocument, sortEntries, type FileEntry } from "../src/lib/files.js";
import { detailFromHash, hashFor, viewFromHash } from "../src/os/views.js";

// The Files and Code workspaces' wording and ordering, and the address that
// carries a folder.

const entry = (name: string, directory: boolean, bytes: number, modifiedAt: number): FileEntry => ({ name, path: name, directory, bytes, modifiedAt });

test("sizes read in the units a person uses", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(14_540), "14.2 KB");
  assert.equal(formatBytes(3_250_000), "3.1 MB");
});

test("a path is the folders above it, each one a place to go, and its parent", () => {
  assert.deepEqual(crumbs("app2/src/lib"), [
    { name: "app2", path: "app2" }, { name: "src", path: "app2/src" }, { name: "lib", path: "app2/src/lib" }
  ]);
  assert.deepEqual(crumbs("."), []);
  assert.equal(parentOf("app2/src"), "app2");
  assert.equal(parentOf("app2"), ".");
});

test("a file's kind decides how it is shown, and SVG is never shown as a picture", () => {
  assert.equal(fileKind("shot.PNG"), "image");
  assert.equal(fileKind("video.mp4"), "video");
  assert.equal(fileKind("README.md"), "markdown");
  assert.equal(fileKind("server.js"), "code");
  assert.equal(fileKind("drawing.svg"), "code", "it can carry script");
  assert.equal(fileKind("Dockerfile"), "text");
  assert.equal(fileKind("report.pdf"), "document");
  assert.equal(fileKind("archive.zip"), "other");
  assert.equal(languageOf("index.tsx"), "TypeScript");
  assert.equal(languageOf("notes"), null);
});

test("folders come first however a folder is sorted, and names sort as a person sorts them", () => {
  const list = [entry("item10", false, 5, 3), entry("item2", false, 50, 1), entry("src", true, 0, 2)];
  assert.deepEqual(sortEntries(list, "name").map((item) => item.name), ["src", "item2", "item10"]);
  assert.deepEqual(sortEntries(list, "newest").map((item) => item.name), ["src", "item10", "item2"]);
  assert.deepEqual(sortEntries(list, "size").map((item) => item.name), ["src", "item2", "item10"]);
});

test("the path as this PC writes it", () => {
  assert.equal(absolutePath("D:\\Vexora\\workspace", "app2/server.js"), "D:\\Vexora\\workspace\\app2\\server.js");
  assert.equal(absolutePath("/home/me/workspace/", "."), "/home/me/workspace");
});

test("an address carries a folder within its view, and survives the round trip", () => {
  const hash = `#${hashFor("files", "app2/src lib")}`;
  assert.equal(viewFromHash(hash), "files");
  assert.equal(detailFromHash(hash), "app2/src lib");
  assert.equal(detailFromHash("#files"), null);
  assert.equal(hashFor("code"), "code");
  assert.equal(detailFromHash("#files/%E0%A4%A"), null, "a broken address is no place, not a crash");
});

test("summarising is offered only for the documents TRH AI can read", () => {
  for (const name of ["report.pdf", "notes.DOCX", "deck.pptx"]) assert.equal(readableDocument(name), true, name);
  // Documents to the file list, but the API has nothing that reads them.
  for (const name of ["old.doc", "old.ppt", "sheet.xlsx", "sheet.xls", "readme.md"]) assert.equal(readableDocument(name), false, name);
});

test("a button to open a file is offered for documents, pictures, sound and video, and never for anything that could run", () => {
  for (const name of ["Report.docx", "scan.PDF", "sheet.xlsx", "deck.pptx", "photo.jpg", "song.mp3", "clip.mp4", "notes.txt", "data.csv", "documents/Quarterly Report.docx"]) assert.equal(canOpenInProgram(name), true, name);
  for (const name of ["setup.exe", "run.bat", "go.ps1", "page.html", "drawing.svg", "macro.docm", "app.js", "README", "archive.zip", "link.lnk", ""]) assert.equal(canOpenInProgram(name), false, name);
});

test("the files a reply says it made are paths in the workspace, a few, and nothing else the reply names is trusted", () => {
  assert.deepEqual(madeFilesFrom(["documents/Report.docx", "documents/Report.pdf"]), ["documents/Report.docx", "documents/Report.pdf"]);
  assert.deepEqual(madeFilesFrom(undefined), []);
  assert.deepEqual(madeFilesFrom("documents/Report.docx"), []);
  const nasty = [42, null, {}, "", "/etc/passwd", "C:\\Windows\\notepad.exe", "d:/x.docx", "../outside.docx", "a/../../b.docx", "a\\..\\b.docx", "x".repeat(1001), "a\0b.docx"];
  assert.deepEqual(madeFilesFrom([...nasty, "documents/ok.docx"]), ["documents/ok.docx"]);
  assert.equal(madeFilesFrom(Array.from({ length: 50 }, (_, index) => `documents/${index}.docx`)).length, 20);
});

test("a conversation opened again finds its files in the reply's own lines, and in nothing else", () => {
  const reply = [
    "Here you go.",
    "",
    'Made "Meeting Notes", 47 words, and read each file back to check it:',
    "- documents/Meeting Notes.docx (Word document)",
    "- documents/Meeting Notes.pdf (PDF, 2 pages)",
    "- documents/Meeting Notes.html (web page)",
    "- documents/Meeting Notes.md (Markdown file)",
    "- documents/Meeting Notes.txt (text file)",
    "Note: The PDF opens, but its words were not found."
  ].join("\n");
  assert.deepEqual(madeFilesInText(reply), [
    "documents/Meeting Notes.docx", "documents/Meeting Notes.pdf", "documents/Meeting Notes.html", "documents/Meeting Notes.md", "documents/Meeting Notes.txt"
  ]);
  assert.deepEqual(madeFilesInText("- documents/A.pdf (PDF, 1 page)\r\n* documents/B.docx (Word document)"), ["documents/A.pdf", "documents/B.docx"], "one page, and the other bullet and line end");
  // A file outside the workspace is told by its whole path, and is not offered; nor is a line the tools did not write.
  assert.deepEqual(madeFilesInText("- C:\\Users\\Sam\\Desktop\\Report.docx (Word document)"), []);
  assert.deepEqual(madeFilesInText("- notes.txt (my own notes)\n- see documents/Report.docx (Word document) for more\nWord document: documents/Report.docx"), []);
  assert.deepEqual(madeFilesInText("- ../outside.docx (Word document)"), []);
  assert.deepEqual(madeFilesInText(""), []);
});
