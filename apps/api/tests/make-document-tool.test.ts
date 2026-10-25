import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The assistant can make a Word file or a PDF. What is tested here is when it is offered the tool, what the tool
// does with what it passes, where the files go and where they may not, and that what it reports is what is on disk.

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-make-document-"));
process.env.ASCEND_WORKSPACE = workspace;
const outside = mkdtempSync(path.join(tmpdir(), "trhai-make-document-outside-"));
const fakeRenderer = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fakeRenderer.mjs");

const { availableTools, runTool, toolDefinitions } = await import("../src/services/agentTools.js");
const { wantsAFileMade } = await import("../src/services/actionIntent.js");
const { extractDocumentText } = await import("../src/services/documentText.js");
const { armCommandsFor, disarmCommands } = await import("../src/services/commandRunner.js");
const { describeTools } = await import("../src/services/toolCenter.js");
const { takeMadeFiles } = await import("../src/services/madeFiles.js");
const { permissionLevelOf } = await import("../src/services/toolPermissions.js");

test.after(() => {
  disarmCommands();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
test.beforeEach(() => { disarmCommands(); });

const names = (tools: Array<{ function: { name: string } }>) => tools.map((tool) => tool.function.name);
const context = (request = "make a word document", extra: Record<string, unknown> = {}) => ({ memories: [], knowledge: [], request, ...extra }) as never;
const tool = (args: Record<string, unknown>, request?: string, extra?: Record<string, unknown>) => runTool({ name: "make_document", arguments: args }, context(request, extra));
const inWorkspace = (...parts: string[]) => path.join(workspace, ...parts);

const report = [
  "# Quarterly Report",
  "",
  "Revenue grew in **every** region.",
  "",
  "- North: up 4%",
  "- South: up 6%",
  "",
  "The end of the report."
].join("\n");

/** Runs `body` with a stand-in for the window that prints PDFs, one that writes a real PDF of the page's own text. */
async function withPrinter<T>(body: () => Promise<T>): Promise<T> {
  const saved = { electron: process.env.TRHAI_ELECTRON_PATH, script: process.env.TRHAI_RENDERER_SCRIPT, mode: process.env.FAKE_RENDER };
  process.env.TRHAI_ELECTRON_PATH = process.execPath;
  process.env.TRHAI_RENDERER_SCRIPT = fakeRenderer;
  process.env.FAKE_RENDER = "readable";
  try {
    return await body();
  } finally {
    for (const [name, value] of [["TRHAI_ELECTRON_PATH", saved.electron], ["TRHAI_RENDERER_SCRIPT", saved.script], ["FAKE_RENDER", saved.mode]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

// ---------------------------------------------------------------- when it is offered

test("a request for a file is told from a request for words to read", () => {
  for (const asked of [
    "make me a Word document about our trip",
    "Create a PDF of this",
    "put the minutes in a docx",
    "write a report on the quarter",
    "I need a resume",
    "turn this into a PDF",
    "Can you export that as a Word doc?",
    "save it as a pdf",
    "generate an invoice for Sam",
    "draft a contract for the sale",
    "convert my notes to Word",
    "make a one-pager for the launch",
    "write the proposal in a Word file",
    "give me a PDF of the schedule"
  ]) assert.equal(wantsAFileMade(asked), true, asked);
  for (const asked of [
    "write me a cover letter",
    "write a two-sentence description for a water bottle",
    "what is a pdf?",
    "read my resume.pdf",
    "summarize this PDF",
    "create a text file called notes.txt",
    "update the README.md",
    "give me three ideas for a blog post",
    "what should go in a report?",
    "write a haiku about autumn",
    "make a snake game",
    "open report.pdf",
    "make a music video from my song"
  ]) assert.equal(wantsAFileMade(asked), false, asked);
});

test("the tool is offered when a file is asked for, and not to a question, a read, or any other request", () => {
  assert.ok(names(availableTools(true, { fileMaking: true })).includes("make_document"));
  assert.ok(!names(availableTools(true, { fileMaking: false })).includes("make_document"), "not asked for");
  assert.ok(!names(availableTools(true, { fileMaking: true, writes: false })).includes("make_document"), "a question writes nothing");
  assert.ok(!names(availableTools(true, { fileMaking: true, changes: false })).includes("make_document"), "a request to look changes nothing");
  assert.ok(names(availableTools(true)).includes("make_document"), "the full set has it");
});

test("what the model is told says what to write, what it does not do, and what to say afterwards", () => {
  const definition = toolDefinitions.find((entry) => entry.function.name === "make_document");
  assert.ok(definition);
  const description = definition.function.description;
  assert.match(description, /Word document \(\.docx\), a PDF/);
  assert.match(description, /WHOLE document/);
  assert.match(description, /Markdown/);
  assert.match(description, /never replaces one/);
  assert.match(description, /write_document/, "told apart from the knowledge base");
  assert.deepEqual(definition.function.parameters.required, ["content"]);
  assert.deepEqual(Object.keys(definition.function.parameters.properties).sort(), ["content", "folder", "format", "paper", "title"]);
  assert.equal(permissionLevelOf("make_document"), 2);
});

test("the tool center says what it makes, and that a PDF needs the window that prints it", () => {
  const probe = { machineAccess: { armed: false, until: null }, model: { available: true, name: "m", reason: null }, visionModel: null, ffmpeg: true, piper: true, phoneLink: "linked" as const, emailAccount: null };
  const entry = (extra: object) => describeTools({ ...probe, ...extra }).find((found) => found.name === "make_document")!;
  assert.equal(entry({}).readiness.state, "ready");
  assert.match(entry({ pdfPrinter: true }).readiness.note ?? "", /Word, PDF, web page/);
  assert.equal(entry({ pdfPrinter: false }).readiness.state, "ready", "Word files still work");
  assert.match(entry({ pdfPrinter: false }).readiness.note ?? "", /PDFs need TRH AI's own window/);
  assert.equal(entry({}).asksFirst, false);
});

// ---------------------------------------------------------------- making files

test("a Word file is made in the documents folder, and the reply says where it is and that it was checked", async () => {
  const result = await tool({ content: report });
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, "documents/Quarterly Report.docx");
  assert.match(result.content, /^Made "Quarterly Report", 18 words, and read each file back to check it:\n- documents\/Quarterly Report\.docx \(Word document\)$/);
  const file = inWorkspace("documents", "Quarterly Report.docx");
  assert.equal(existsSync(file), true);
  const read = await extractDocumentText(readFileSync(file), "Quarterly Report.docx");
  assert.ok(read.ok && /The end of the report\./.test(read.text));
});

test("a second document with the same title is a new file, not a replacement", async () => {
  const first = await tool({ content: "# Same Title\n\nFirst version." });
  const second = await tool({ content: "# Same Title\n\nSecond version." });
  assert.equal(first.path, "documents/Same Title.docx");
  assert.equal(second.path, "documents/Same Title (2).docx");
  const first_ = await extractDocumentText(readFileSync(inWorkspace("documents", "Same Title.docx")), "a.docx");
  assert.ok(first_.ok && /First version/.test(first_.text), "the first is as it was");
});

test("a Word file and a PDF are made together, from the same text", async () => {
  const result = await withPrinter(() => tool({ content: report, format: "Word and PDF", title: "Board Pack" }));
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, "documents/Board Pack.docx");
  assert.match(result.content, /- documents\/Board Pack\.docx \(Word document\)\n- documents\/Board Pack\.pdf \(PDF, 1 page\)/);
  assert.match(result.content, /read each file back to check it/);
  const pdf = await extractDocumentText(readFileSync(inWorkspace("documents", "Board Pack.pdf")), "Board Pack.pdf");
  assert.ok(pdf.ok);
  if (pdf.ok) {
    assert.match(pdf.text, /Quarterly Report/);
    assert.match(pdf.text, /The end of the report\./);
  }
});

test("a PDF that cannot be printed is said so, and the Word file made beside it is still there", async () => {
  const saved = process.env.TRHAI_ELECTRON_PATH;
  process.env.TRHAI_ELECTRON_PATH = path.join(outside, "no-electron.exe");
  try {
    const result = await tool({ content: report, format: ["docx", "pdf"], title: "No Printer" });
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /documents\/No Printer\.docx \(Word document\)/);
    assert.doesNotMatch(result.content, /No Printer\.pdf/);
    assert.match(result.content, /Note: The PDF could not be made: TRHAI_ELECTRON_PATH is set to .*no-electron\.exe/);
    assert.equal(existsSync(inWorkspace("documents", "No Printer.pdf")), false, "no empty file is left");
    const only = await tool({ content: report, format: "pdf", title: "No Printer At All" });
    assert.equal(only.ok, false);
    assert.match(only.content, /Nothing was made\.$/);
  } finally {
    if (saved === undefined) delete process.env.TRHAI_ELECTRON_PATH; else process.env.TRHAI_ELECTRON_PATH = saved;
  }
});

// ---------------------------------------------------------------- where

test("a folder in the workspace is made if it is not there, and a file's whole path is understood as folder, title and format", async () => {
  const folder = await tool({ content: report, folder: "reports/q3" });
  assert.equal(folder.path, "reports/q3/Quarterly Report.docx");
  assert.equal(existsSync(inWorkspace("reports", "q3", "Quarterly Report.docx")), true);

  const asFile = await withPrinter(() => tool({ content: report, folder: "reports/Budget Summary.pdf" }));
  assert.equal(asFile.ok, true, asFile.content);
  assert.equal(asFile.path, "reports/Budget Summary.pdf", "the ending of the name chose the format, its stem the title");
  assert.equal(existsSync(inWorkspace("reports", "Budget Summary.pdf")), true);
  assert.equal(existsSync(inWorkspace("reports", "Budget Summary.docx")), false);

  const formatWins = await tool({ content: report, folder: "reports/Plan.pdf", format: "docx" });
  assert.equal(formatWins.path, "reports/Plan.docx", "a format that was asked for is not overruled by a file name");
});

test("without machine access a place outside the workspace is refused, in the words a person uses for it or as a path, and nothing is made", async () => {
  for (const folder of [path.join(outside, "elsewhere"), "Desktop", "my downloads folder", "~/Documents/Taxes"]) {
    const result = await tool({ content: report, folder });
    assert.equal(result.ok, false, folder);
    assert.match(result.content, /outside my workspace\. Turn on machine access/, folder);
    assert.match(result.content, /Nothing was made\.$/);
  }
  assert.deepEqual(readdirSync(outside), [], "nothing was written outside");
});

test("with machine access on, a full path is written to, and an unattended run still stays in the workspace", async () => {
  armCommandsFor(60_000);
  const target = path.join(outside, "Invoices");
  const result = await tool({ content: "# Invoice 17\n\nTotal: 40.", folder: target });
  assert.equal(result.ok, true, result.content);
  assert.equal(result.path, path.join(target, "Invoice 17.docx"), "outside the workspace it is reported by where it really is");
  assert.match(result.content, new RegExp(`- ${target.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}[\\\\/]Invoice 17\\.docx \\(Word document\\)`));
  assert.equal(existsSync(path.join(target, "Invoice 17.docx")), true);

  const unattended = await tool({ content: report, folder: path.join(outside, "Unattended") }, undefined, { unattended: true });
  assert.equal(unattended.ok, false);
  assert.match(unattended.content, /outside my workspace/);
  assert.equal(existsSync(path.join(outside, "Unattended")), false);
});

test("the screen is offered the files made in the workspace to open, and not those made anywhere else", async () => {
  takeMadeFiles("offered");
  const inside = await tool({ content: "# Inside The Workspace\n\nBody text here." }, undefined, { sessionId: "offered" });
  assert.equal(inside.ok, true, inside.content);
  assert.deepEqual(takeMadeFiles("offered"), ["documents/Inside The Workspace.docx"]);
  assert.deepEqual(takeMadeFiles("offered"), [], "handed over once");
  armCommandsFor(60_000);
  const elsewhere = await tool({ content: "# Somewhere Else\n\nBody text here.", folder: path.join(outside, "Elsewhere") }, undefined, { sessionId: "offered" });
  assert.equal(elsewhere.ok, true, elsewhere.content);
  assert.deepEqual(takeMadeFiles("offered"), [], "a file outside the workspace is not one the screen can open");
  const both = await tool({ content: "# Two Formats\n\nBody text here.", format: "docx, txt" }, undefined, { sessionId: "offered" });
  assert.equal(both.ok, true, both.content);
  assert.deepEqual(takeMadeFiles("offered"), ["documents/Two Formats.docx", "documents/Two Formats.txt"]);
  const unnamed = await tool({ content: "# No Conversation\n\nBody text here." });
  assert.equal(unnamed.ok, true);
  assert.deepEqual(takeMadeFiles(undefined), [], "with no conversation there is nobody to tell");
});

test("a system folder is refused even with machine access on", async () => {
  armCommandsFor(60_000);
  const system = process.platform === "win32" ? "C:\\Windows\\System32\\Made" : "/etc/made";
  const result = await tool({ content: report, folder: system });
  assert.equal(result.ok, false);
  assert.match(result.content, /is a system location/);
  assert.match(result.content, /Nothing was made\.$/);
});

// ---------------------------------------------------------------- what is refused

test("what is not a document, or not the whole of one, is refused before anything is written", async () => {
  const before = existsSync(inWorkspace("documents")) ? readdirSync(inWorkspace("documents")).length : 0;
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{}, /needs the whole text of the document/],
    [{ content: "   \n  " }, /needs the whole text of the document/],
    [{ content: "<content>" }, /placeholder/],
    [{ content: "# Notes\n\n[Lines 1-40 of 400]\n\nand more" }, /heading of a partial read.*not the whole document/],
    [{ content: report, format: "excel" }, /"excel" is not a format I can make/],
    [{ content: report, format: "docx, rtf" }, /"rtf" is not a format/],
    [{ content: report, paper: "Legal" }, /paper must be "A4" or "Letter"/],
    [{ content: "word ".repeat(70_000) }, /a document can be up to 300,000/]
  ];
  for (const [args, pattern] of cases) {
    const result = await tool(args);
    assert.equal(result.ok, false, JSON.stringify(args).slice(0, 60));
    assert.match(result.content, pattern);
    assert.match(result.content, /Nothing was made\.$/);
  }
  const after = existsSync(inWorkspace("documents")) ? readdirSync(inWorkspace("documents")).length : 0;
  assert.equal(after, before, "nothing new was written");
});

test("the paper asked for reaches the file", async () => {
  const result = await tool({ content: "# Letter Sized\n\nBody.", paper: "US Letter", format: "html" });
  assert.equal(result.ok, true, result.content);
  assert.match(readFileSync(inWorkspace("documents", "Letter Sized.html"), "utf8"), /@page \{ size: Letter;/);
  const a4 = await tool({ content: "# Metric Sized\n\nBody.", paper: "a4", format: "html" });
  assert.equal(a4.ok, true, a4.content);
  assert.match(readFileSync(inWorkspace("documents", "Metric Sized.html"), "utf8"), /@page \{ size: A4;/);
});

test("the file tools do not write a Word or PDF file that nothing can open, and say what to use instead", async () => {
  for (const [name, args] of [
    ["write_file", { path: "letter.docx", content: "Dear Sam, thanks for the books." }],
    ["write_file", { path: "letter.pdf", content: "Dear Sam, thanks for the books." }],
    ["edit_file", { path: "letter.docx", append: "More." }]
  ] as const) {
    const result = await runTool({ name, arguments: args }, context("write letter.docx"));
    assert.equal(result.ok, false, `${name} ${args.path}`);
    assert.match(result.content, /use make_document with the text of the document/, `${name} ${args.path}`);
  }
  const slides = await runTool({ name: "write_file", arguments: { path: "deck.pptx", content: "Slide one and more words." } }, context("write deck.pptx"));
  assert.equal(slides.ok, false);
  assert.doesNotMatch(slides.content, /make_document/, "a presentation is not one of its files");
  assert.match(slides.content, /Write the text to a \.txt or \.md file instead\./);
  assert.equal(existsSync(inWorkspace("letter.docx")), false);
});

test("a folder that is already a file in the workspace cannot hold documents, and says so plainly", async () => {
  mkdirSync(inWorkspace("blocked"), { recursive: true });
  await runTool({ name: "write_file", arguments: { path: "blocked/taken", content: "just a file in the way of the folder" } }, context("write blocked/taken"));
  const result = await tool({ content: report, folder: "blocked/taken" });
  assert.equal(result.ok, false);
  assert.match(result.content, /The folder could not be made|Nothing could be written in that folder/);
});
