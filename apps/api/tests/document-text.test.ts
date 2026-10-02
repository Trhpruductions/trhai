import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { once } from "node:events";

// Stores and the workspace of their own, set before anything that reads them is imported.
const dataDir = mkdtempSync(path.join(tmpdir(), "trhai-documents-"));
const workspace = mkdtempSync(path.join(tmpdir(), "trhai-documents-ws-"));
process.env.ASCEND_WORKSPACE = workspace;
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dataDir, "knowledge.json");
process.env.ASSIST_MEMORY_FILE = path.join(dataDir, "memory.json");
process.env.ASSIST_ACCOUNTS_FILE = path.join(dataDir, "accounts.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dataDir, "conversations.json");
process.env.ASSIST_TASKS_FILE = path.join(dataDir, "tasks.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dataDir, "preferences.json");

const { docxText, documentKind, extractDocumentText, htmlText, readZip, slideText, maxDocumentBytes } =
  await import("../src/services/documentText.js");
const { chunkDocument, maxPassageChars, splitLongPassage } = await import("../src/services/knowledgeStore.js");
const { runTool } = await import("../src/services/agentTools.js");
const { createApp } = await import("../src/server.js");

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

// ------------------------------------------------------------- fixtures

/** A zip archive, the way Office writes one: deflated entries, a central directory, the end record. */
function zip(files: Record<string, string>, method: 0 | 8 = 8): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf8");
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const wordBody = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="w"><w:body>`
  + `<w:p><w:r><w:t>Rollback plan</w:t></w:r></w:p>`
  + `<w:p><w:r><w:t xml:space="preserve">Run the script </w:t></w:r><w:r><w:t>rollback.sh &amp; check &lt;status&gt;.</w:t></w:r></w:p>`
  + `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Ada</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
  + `<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t><w:tab/><w:t>tabbed</w:t></w:r></w:p>`
  + `</w:body></w:document>`;

function docx(): Buffer {
  return zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": wordBody });
}

function pptx(): Buffer {
  const slide = (text: string) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  // Out of order on purpose: slide10 must come after slide2.
  return zip({ "ppt/slides/slide10.xml": slide("Ten"), "ppt/slides/slide1.xml": slide("One"), "ppt/slides/slide2.xml": slide("Two") });
}

/** A small real PDF: one page of text per entry, Helvetica, offsets computed so the xref is exact. */
function pdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, index) => {
    const stream = text ? `BT /F1 12 Tf 72 712 Td (${text}) Tj ET` : "";
    objects[pageIds[index]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index] + 1} 0 R >>`;
    objects[pageIds[index] + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

// ------------------------------------------------------------- reading

test("a file's kind comes from its bytes first and its name second", () => {
  assert.equal(documentKind(pdf(["x"]), "anything.bin"), "pdf", "a PDF is a PDF whatever it is called");
  assert.equal(documentKind(docx(), "notes.docx"), "docx");
  assert.equal(documentKind(pptx(), "deck.pptx"), "pptx");
  assert.equal(documentKind(Buffer.from("hello"), "notes.md"), "text");
  assert.equal(documentKind(docx(), "archive.zip"), null, "a zip that is not an Office file is not a document");
  assert.equal(documentKind(Buffer.from([0, 1, 2]), "photo.jpg"), null);
});

test("a Word document reads as its paragraphs, with tables and breaks kept apart", () => {
  const text = docxText(wordBody);
  assert.match(text, /^Rollback plan\n\nRun the script rollback\.sh & check <status>\./, "runs joined, entities decoded");
  assert.match(text, /Owner\tAda/, "table cells separated");
  assert.match(text, /Line one\nLine two\ttabbed/, "breaks and tabs kept");
  assert.doesNotMatch(text, /<\/?w:|\u0001/, "no XML or cell markers left - the document's own \"<status>\" is text");
});

test("slides read in their own order, and HTML reads as text", () => {
  assert.equal(slideText("<a:p><a:r><a:t>Q3 &amp; Q4</a:t></a:r></a:p><a:p><a:r><a:t>Growth</a:t></a:r></a:p>"), "Q3 & Q4\nGrowth");
  assert.equal(htmlText("<html><style>p{}</style><body><h1>Title</h1><p>One &amp; two<br>three</p><script>x()</script></body></html>"),
    "Title\n\nOne & two\nthree");
});

test("the zip reader handles stored and deflated entries alike", () => {
  for (const method of [0, 8] as const) {
    const entries = readZip(zip({ "a.txt": "alpha", "dir/b.xml": "<b/>" }, method));
    assert.deepEqual([...entries.keys()], ["a.txt", "dir/b.xml"]);
    assert.equal(entries.get("a.txt")!().toString(), "alpha");
  }
  assert.throws(() => readZip(Buffer.from("not a zip at all, just some text that is long enough")), /not a complete zip/);
});

test("PDF, Word, PowerPoint and text files all come back as text", async () => {
  const fromPdf = await extractDocumentText(pdf(["Quarterly report: revenue grew 12 percent.", "Page two says costs fell."]), "report.pdf");
  assert.equal(fromPdf.ok, true);
  if (fromPdf.ok) {
    assert.equal(fromPdf.kind, "pdf");
    assert.equal(fromPdf.pages, 2);
    assert.match(fromPdf.text, /revenue grew 12 percent/);
    assert.match(fromPdf.text, /costs fell/);
  }

  const fromWord = await extractDocumentText(docx(), "plan.docx");
  assert.equal(fromWord.ok && fromWord.kind, "docx");
  assert.match(fromWord.ok ? fromWord.text : "", /rollback\.sh/);

  const fromSlides = await extractDocumentText(pptx(), "deck.pptx");
  assert.equal(fromSlides.ok, true);
  if (fromSlides.ok) {
    assert.equal(fromSlides.pages, 3);
    assert.match(fromSlides.text, /^Slide 1\nOne\n\nSlide 2\nTwo\n\nSlide 10\nTen$/);
  }

  const fromText = await extractDocumentText(Buffer.from("\uFEFFhello\n\n\n\nworld  \n"), "notes.txt");
  assert.deepEqual(fromText, { ok: true, kind: "text", text: "hello\n\nworld" });
});

test("what cannot be read says why, and what would help", async () => {
  const scanned = await extractDocumentText(pdf([""]), "scan.pdf");
  assert.equal(scanned.ok, false);
  if (!scanned.ok) assert.match(scanned.reason, /scanned pages/);

  const unknown = await extractDocumentText(Buffer.from([1, 2, 3]), "photo.jpg");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.reason, /PDF, Word \(\.docx\), PowerPoint \(\.pptx\) and plain-text/);

  const empty = await extractDocumentText(Buffer.alloc(0), "x.pdf");
  assert.equal(empty.ok, false);

  const damaged = await extractDocumentText(Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(40)]), "broken.docx");
  assert.equal(damaged.ok, false);
  if (!damaged.ok) assert.match(damaged.reason, /could not be read/);
  assert.ok(maxDocumentBytes >= 10 * 1024 * 1024);
});

// ------------------------------------------------------------- the knowledge base

test("a long block with no blank lines is cut into passages at sentence ends", () => {
  const sentence = "The rollback restores the previous release and checks the health endpoint. ";
  const block = sentence.repeat(60).trim();
  const pieces = splitLongPassage(block);
  assert.ok(pieces.length > 1);
  assert.ok(pieces.every((piece) => piece.length <= maxPassageChars), "no passage over the limit");
  assert.ok(pieces.every((piece) => piece.endsWith(".")), "cut at sentence ends");
  assert.equal(pieces.join(" "), block, "nothing lost or reordered");

  const passages = chunkDocument({ id: "d1", title: "PDF", body: `Heading\n\n${block}`, createdAt: "2026-10-01T00:00:00.000Z" });
  assert.ok(passages.every((passage) => passage.body.length <= maxPassageChars + 20));
  assert.ok(passages[0].body.startsWith("Heading "), "the heading still joins the text beneath it");
  assert.deepEqual(splitLongPassage("short"), ["short"]);
});

// ------------------------------------------------------------- the agent's file tools

test("read_file reads a PDF or Word file on disk as text", async () => {
  writeFileSync(path.join(workspace, "report.pdf"), pdf(["Revenue grew 12 percent in Q3."]));
  writeFileSync(path.join(workspace, "plan.docx"), docx());
  const fromPdf = await runTool({ name: "read_file", arguments: { path: "report.pdf" } }, { memories: [], knowledge: [] });
  assert.equal(fromPdf.ok, true);
  assert.match(fromPdf.content, /Revenue grew 12 percent in Q3/);
  const fromWord = await runTool({ name: "read_file", arguments: { path: "plan.docx" } }, { memories: [], knowledge: [] });
  assert.match(fromWord.content, /Owner\tAda/);
});

test("plain text is never written over a PDF or Word file", async () => {
  const before = readFileSync(path.join(workspace, "report.pdf"));
  const write = await runTool({ name: "write_file", arguments: { path: "report.pdf", content: "Revenue grew 15 percent." } },
    { memories: [], knowledge: [], request: "change the revenue figure in report.pdf to 15 percent" });
  assert.equal(write.ok, false);
  assert.match(write.content, /PDF document/);
  assert.match(write.content, /\.txt or \.md/);
  assert.deepEqual(readFileSync(path.join(workspace, "report.pdf")), before, "the PDF is untouched");

  const created = await runTool({ name: "write_file", arguments: { path: "new.docx", content: "hello" } },
    { memories: [], knowledge: [], request: "write hello to new.docx" });
  assert.equal(created.ok, false);
  assert.equal(existsSync(path.join(workspace, "new.docx")), false);
});

// ------------------------------------------------------------- the import route

test("a file sent to the import route becomes a knowledge document", async () => {
  const app = createApp();
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const send = (name: string, body: Buffer) => fetch(`${base}/v1/knowledge/import?sessionId=doc-session&name=${encodeURIComponent(name)}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body
    });

    const imported = await send("Q3_report.pdf", pdf(["Revenue grew 12 percent in Q3.", "Costs fell."]));
    assert.equal(imported.status, 201);
    const payload = await imported.json() as { data: { document: { title: string; characters: number }; kind: string; pages: number; truncated: boolean } };
    assert.equal(payload.data.document.title, "Q3 report");
    assert.equal(payload.data.kind, "pdf");
    assert.equal(payload.data.pages, 2);
    assert.equal(payload.data.truncated, false);
    assert.ok(!("body" in payload.data.document), "the reply does not echo the whole text back");

    const listed = await (await fetch(`${base}/v1/knowledge?sessionId=doc-session`)).json() as { data: { documents: Array<{ title: string; body: string }> } };
    assert.match(listed.data.documents.find((entry) => entry.title === "Q3 report")?.body ?? "", /Revenue grew 12 percent/);

    const unreadable = await send("photo.jpg", Buffer.from([1, 2, 3, 4]));
    assert.equal(unreadable.status, 422);
    assert.match((await unreadable.json() as { message: string }).message, /PDF, Word/);

    const nameless = await fetch(`${base}/v1/knowledge/import?sessionId=doc-session`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("x")
    });
    assert.equal(nameless.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
