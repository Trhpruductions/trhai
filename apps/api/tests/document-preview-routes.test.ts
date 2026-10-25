import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { tinyPdf } from "./helpers/pdf.js";

// The Files screen shows the words in a PDF, Word or PowerPoint file it cannot draw. What is tested here is what a
// caller gets for each kind of file, and that nothing outside the workspace, and nothing that is not a document, is read.

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-doc-preview-"));
const outside = mkdtempSync(path.join(tmpdir(), "trhai-doc-preview-outside-"));
process.env.ASCEND_WORKSPACE = workspace;
mkdirSync(path.join(workspace, "documents"), { recursive: true });

const { createApp } = await import("../src/server.js");
const { makeDocument } = await import("../src/services/documentMaker.js");
const { previewCharacters } = await import("../src/documentPreviewRoutes.js");

const made = await makeDocument({ content: "# Meeting Notes\n\n- Budget approved\n- Hiring paused\n\nNext meeting on Friday.", formats: ["docx"], language: "en-US" }, path.join(workspace, "documents"));
assert.ok(made.ok);
writeFileSync(path.join(workspace, "documents", "scan.pdf"), tinyPdf(["Invoice 17", "Total due: 40"]));
writeFileSync(path.join(workspace, "documents", "broken.docx"), "this is not a zip file at all, just words");
writeFileSync(path.join(workspace, "documents", "notes.txt"), "plain text is read another way");
const long = await makeDocument({ content: `# Long\n\n${"word ".repeat(50_000)}`, title: "Long Document", formats: ["docx"] }, path.join(workspace, "documents"));
assert.ok(long.ok);
writeFileSync(path.join(outside, "secret.docx"), "x");

const server = createApp().listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function preview(file: string) {
  const response = await fetch(`${baseUrl}/v1/files/document?path=${encodeURIComponent(file)}`);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

test("a Word file comes back as its words", async () => {
  const { status, body } = await preview("documents/Meeting Notes.docx");
  assert.equal(status, 200);
  assert.equal(body.data.kind, "docx");
  assert.equal(body.data.truncated, false);
  assert.match(body.data.text, /Meeting Notes/);
  assert.match(body.data.text, /Budget approved/);
  assert.match(body.data.text, /Next meeting on Friday\./);
  assert.equal(body.data.path, "documents/Meeting Notes.docx");
});

test("a PDF comes back as its words, with its page count", async () => {
  const { status, body } = await preview("documents/scan.pdf");
  assert.equal(status, 200);
  assert.equal(body.data.kind, "pdf");
  assert.equal(body.data.pages, 1);
  assert.match(body.data.text, /Invoice 17/);
  assert.match(body.data.text, /Total due: 40/);
});

test("a long document is cut where the preview ends, and says how long it was", async () => {
  const { status, body } = await preview("documents/Long Document.docx");
  assert.equal(status, 200);
  assert.equal(body.data.truncated, true);
  assert.equal(body.data.text.length, previewCharacters);
  assert.ok(body.data.characters > previewCharacters);
});

test("a file that is not a document, one that is not there, a folder and a damaged file are each said plainly", async () => {
  const cases: Array<[string, number, string]> = [
    ["documents/notes.txt", 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["documents/missing.pdf", 404, "NOT_FOUND"],
    ["documents", 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["documents/broken.docx", 422, "UNREADABLE"]
  ];
  for (const [file, status, code] of cases) {
    const reply = await preview(file);
    assert.equal(reply.status, status, file);
    assert.equal(reply.body.code, code, file);
    assert.equal(typeof reply.body.message, "string");
  }
});

test("a file too big to read is said to be, and is not read", async () => {
  writeFileSync(path.join(workspace, "documents", "huge.pdf"), Buffer.alloc(41 * 1024 * 1024));
  const { status, body } = await preview("documents/huge.pdf");
  assert.equal(status, 413);
  assert.equal(body.code, "PAYLOAD_TOO_LARGE");
  assert.match(body.message, /41 MB; documents up to 40 MB can be read/);
});

test("nothing outside the workspace is read, however it is asked for", async () => {
  for (const file of [path.join(outside, "secret.docx"), `../${path.basename(outside)}/secret.docx`, "..\\..\\secret.docx", "", "documents/\0x.docx"]) {
    const reply = await preview(file);
    assert.equal(reply.status, 400, JSON.stringify(file));
    assert.equal(reply.body.code, "INVALID_REQUEST");
  }
  const missing = await fetch(`${baseUrl}/v1/files/document`);
  assert.equal(missing.status, 400);
});
