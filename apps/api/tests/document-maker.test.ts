import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  countWords, describeMadeDocument, documentSource, edgeWords, fileStem, makeDocument, paperForLocale, parseDocumentFormats,
  plainTextDocument, titleOf, type DocumentFormat
} from "../src/services/documentMaker.js";
import { extractDocumentText, readZip } from "../src/services/documentText.js";
import { parseMarkdown } from "../src/services/markdown.js";
import type { renderPdfs } from "../src/services/frameRenderer.js";
import { tinyPdf } from "./helpers/pdf.js";

const folder = mkdtempSync(path.join(tmpdir(), "trhai-document-maker-"));
let counter = 0;
const fresh = () => path.join(folder, `case-${(counter += 1)}`, "documents");
process.on("exit", () => rmSync(folder, { recursive: true, force: true }));

const sample = [
  "# Quarterly Report",
  "",
  "Revenue grew in **every** region.",
  "",
  "- North: up 4%",
  "- South: up 6%",
  "",
  "The end of the report."
].join("\n");
const sampleLines = ["Quarterly Report", "Revenue grew in every region.", "North: up 4%", "South: up 6%", "The end of the report."];

/** A stand-in for printing that writes a real, readable PDF holding these lines. */
const printing = (lines: string[]): typeof renderPdfs => async (jobs) => {
  for (const job of jobs) writeFileSync(job.outputPath, tinyPdf(lines));
  return { ok: true, rendered: jobs.length };
};

// ---------------------------------------------------------------- what was asked for

test("the formats asked for are understood the way a model says them", () => {
  const formats = (value: unknown) => { const parsed = parseDocumentFormats(value); return parsed.ok ? parsed.formats : parsed.reason; };
  assert.deepEqual(formats(undefined), ["docx"]);
  assert.deepEqual(formats(""), ["docx"]);
  assert.deepEqual(formats("docx"), ["docx"]);
  assert.deepEqual(formats("Word"), ["docx"]);
  assert.deepEqual(formats(".docx"), ["docx"]);
  assert.deepEqual(formats("PDF"), ["pdf"]);
  assert.deepEqual(formats("pdf and word"), ["pdf", "docx"]);
  assert.deepEqual(formats("a Word document and a PDF file"), ["docx", "pdf"]);
  assert.deepEqual(formats("docx, pdf, html"), ["docx", "pdf", "html"]);
  assert.deepEqual(formats(["docx", "PDF", "docx"]), ["docx", "pdf"]);
  assert.deepEqual(formats("markdown/plain text"), ["md", "txt"]);
  assert.deepEqual(formats("web page"), ["html"]);
});

test("a format that does not exist is refused with the ones that do, not guessed at", () => {
  const refused = parseDocumentFormats("excel");
  assert.equal(refused.ok, false);
  assert.match((refused as { reason: string }).reason, /"excel" is not a format/);
  assert.match((refused as { reason: string }).reason, /docx \(Word document\), pdf \(PDF\)/);
  assert.equal(parseDocumentFormats("docx and rtf").ok, false);
  assert.equal(parseDocumentFormats(42).ok, false);
});

test("paper follows the place: Letter where it is used, A4 everywhere else", () => {
  for (const locale of ["en-US", "en-CA", "es-MX", "fr-CA", "es-CO", "en-PH"]) assert.equal(paperForLocale(locale), "Letter", locale);
  for (const locale of ["en-GB", "de-DE", "fr-FR", "en-AU", "ja-JP", "pt-BR", "en-IN", "zz-ZZ", "not a locale", ""]) assert.equal(paperForLocale(locale), "A4", locale);
  assert.equal(paperForLocale(undefined), "A4");
  assert.equal(paperForLocale("en"), "Letter", "bare English is read as American");
});

test("newlines sent as the letters backslash and n are made real, and real ones are left alone", () => {
  const sent = "# Title\\n\\nFirst paragraph.\\n\\n- one\\n- two";
  assert.equal(documentSource(sent), "# Title\n\nFirst paragraph.\n\n- one\n- two");
  const real = "Use \\n to end a line.\nSecond line.";
  assert.equal(documentSource(real), real, "with real newlines in it, the two letters are what the text says");
  assert.equal(documentSource("One mention of \\n only."), "One mention of \\n only.");
  assert.equal(documentSource(`${String.fromCharCode(0xfeff)}# Marked`), "# Marked");
});

test("a file name keeps the title's look and drops what no system accepts", () => {
  assert.equal(fileStem("Quarterly Report"), "Quarterly Report");
  assert.equal(fileStem("Q3: Results / 2026"), "Q3 Results 2026");
  assert.equal(fileStem('a<b>c|d?"e*f\\g'), "a b c d e f g");
  assert.equal(fileStem("  .hidden  "), "hidden");
  assert.equal(fileStem("Report..."), "Report");
  assert.equal(fileStem("CON"), "CON document");
  assert.equal(fileStem("nul"), "nul document");
  assert.equal(fileStem("com3"), "com3 document");
  assert.equal(fileStem(""), "Document");
  assert.equal(fileStem("???"), "Document");
  assert.equal(fileStem("日本語のレポート"), "日本語のレポート");
  assert.equal(fileStem("Café menu"), "Café menu", "composed, so one name for one title");
  const long = fileStem("word ".repeat(40));
  assert.ok(long.length <= 80 && !long.endsWith(" "), `cut at a word: ${long.length}`);
  const midWord = fileStem("abcdefghij ".repeat(20));
  assert.ok(midWord.length <= 80 && midWord.split(" ").every((word) => word === "abcdefghij"), `whole words only: ${midWord}`);
  assert.equal(fileStem("x".repeat(200)).length, 80);
});

test("the title is what was given, else the first heading, else the first line, else Document", () => {
  const title = (text: string, given?: string) => titleOf(parseMarkdown(text), given);
  assert.equal(title(sample), "Quarterly Report");
  assert.equal(title(sample, "  My   Report "), "My Report");
  assert.equal(title("Dear Sam,\n\nThanks for the books."), "Dear Sam");
  assert.equal(title("A sentence that goes on and on about nothing in particular, for far more than sixty letters in all."), "A sentence that goes on and on about nothing in...", "cut at a word, not in the middle of one");
  assert.equal(title("---\n"), "Document");
  assert.equal(title("## Second level only"), "Second level only");
});

test("the words a file is checked by come from the running text, not from table cells or code, unless that is all there is", () => {
  const blocks = parseMarkdown([
    "| Head | Cells |", "|---|---|", "| a wrapped cell | here |", "", "Opening words of prose.", "", "```", "some code", "```", "",
    "| Final | Table |", "|---|---|", "| z | y |", "", "Closing words of prose.", "", "| Last | Table |", "|---|---|", "| q | r |"
  ].join("\n"));
  assert.deepEqual(edgeWords(blocks), { first: "openingwordsofprose", last: "closingwordsofprose" });
  assert.deepEqual(edgeWords(parseMarkdown("| A | B |\n|---|---|\n| one | two |")), { first: "a", last: "two" });
  assert.deepEqual(edgeWords(parseMarkdown("```\nonly code\n```")), { first: "onlycode", last: "onlycode" });
});

test("the first and last words, and the word count, are taken from what a reader sees", () => {
  assert.deepEqual(edgeWords(parseMarkdown(sample)), { first: "quarterlyreport", last: "theendofthereport" });
  assert.deepEqual(edgeWords(parseMarkdown("---\n")), { first: "", last: "" });
  assert.equal(countWords(parseMarkdown(sample)), 18);
  assert.equal(countWords(parseMarkdown("日本語のレポートです")) > 1, true, "counted as the language is written");
  assert.equal(countWords(parseMarkdown("")), 0);
});

test("plain text keeps its shape: headings underlined, marks on lists, tables in columns, addresses written out", () => {
  const text = plainTextDocument(parseMarkdown([
    "# Report", "", "Intro with a [link](https://example.com/a) and a [bare](https://example.com/b) one.", "",
    "## Parts", "", "1. first", "2. second", "   - nested", "", "| Name | Score |", "|:-----|------:|", "| Ann | 10 |", "| Bob | 200 |", "",
    "> quoted", "", "```", "code here", "```", "", "---", "", "End"
  ].join("\n")));
  assert.ok(text.includes("\r\n") && !/[^\r]\n/.test(text), "Windows line ends throughout");
  const lines = text.split("\r\n");
  assert.deepEqual(lines.slice(0, 4), ["Report", "======", "", "Intro with a link (https://example.com/a) and a bare (https://example.com/b) one."]);
  assert.ok(lines.includes("Parts") && lines.includes("-----"));
  assert.ok(lines.includes("1. first") && lines.includes("2. second") && lines.includes("   - nested"));
  assert.ok(lines.includes("Name | Score") && lines.includes("Ann  |    10") && lines.includes("Bob  |   200"));
  assert.ok(lines.includes("> quoted") && lines.includes("    code here") && lines.includes("-".repeat(40)));
  assert.equal(lines[lines.length - 2], "End");
  assert.equal(lines[lines.length - 1], "", "ends with a line end");
});

// ---------------------------------------------------------------- making files

test("a document is made in Word unless another format is asked for, named for its title, and read back", async () => {
  const directory = fresh();
  const result = await makeDocument({ content: sample, language: "en-US" }, directory);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.title, "Quarterly Report");
  assert.equal(result.words, 18);
  assert.deepEqual(result.problems, []);
  assert.equal(result.files.length, 1);
  const [file] = result.files;
  assert.equal(file.format, "docx");
  assert.equal(file.name, "Quarterly Report.docx");
  assert.equal(file.path, path.join(directory, "Quarterly Report.docx"));
  assert.equal(file.checked, true);
  assert.ok(file.bytes > 1000);
  assert.deepEqual(readdirSync(directory), ["Quarterly Report.docx"]);
  const read = await extractDocumentText(readFileSync(file.path), file.name);
  assert.ok(read.ok);
  if (read.ok) {
    assert.match(read.text, /Quarterly Report/);
    assert.match(read.text, /North: up 4%/);
    assert.match(read.text, /The end of the report\./);
  }
});

test("every format can be made at once, from the same name, in the order asked", async () => {
  const directory = fresh();
  const formats: DocumentFormat[] = ["pdf", "docx", "html", "md", "txt"];
  const result = await makeDocument({ content: sample, formats, language: "en-US" }, directory, { renderPdfsFn: printing(sampleLines) });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.files.map((file) => file.name), formats.map((format) => `Quarterly Report.${format}`));
  assert.ok(result.files.every((file) => file.checked), "each one was read back and showed the document's first and last words");
  assert.equal(result.files[0].pages, 1);
  assert.equal(result.files[1].pages, undefined, "a page count is only claimed where it was counted");
  const html = readFileSync(path.join(directory, "Quarterly Report.html"), "utf8");
  assert.match(html, /<title>Quarterly Report<\/title>/);
  assert.match(html, /@page \{ size: Letter;/, "the paper follows the language given");
  assert.match(html, /<li>North: up 4%<\/li>/);
  assert.equal(readFileSync(path.join(directory, "Quarterly Report.md"), "utf8"), `${sample}\n`);
  const text = readFileSync(path.join(directory, "Quarterly Report.txt"), "utf8");
  assert.match(text, /^Quarterly Report\r\n=+\r\n/);
  assert.match(text, /- North: up 4%\r\n- South: up 6%/);
});

test("the paper is the one asked for, and otherwise the one the place uses", async () => {
  const wordPage = async (options: { paper?: "A4" | "Letter"; language?: string }) => {
    const directory = fresh();
    const result = await makeDocument({ content: sample, ...options }, directory);
    assert.ok(result.ok);
    const body = readZip(readFileSync(path.join(directory, "Quarterly Report.docx"))).get("word/document.xml")!().toString("utf8");
    return /<w:pgSz w:w="(\d+)" w:h="(\d+)"/.exec(body)!.slice(1, 3).join("x");
  };
  assert.equal(await wordPage({ paper: "A4", language: "en-US" }), "11906x16838");
  assert.equal(await wordPage({ paper: "Letter", language: "en-GB" }), "12240x15840");
  assert.equal(await wordPage({ language: "en-US" }), "12240x15840");
  assert.equal(await wordPage({ language: "en-GB" }), "11906x16838");
});

test("a title that is given names the files, whatever the text's own heading says", async () => {
  const directory = fresh();
  const result = await makeDocument({ content: "# Something else\n\nBody text.", title: "My: Résumé" }, directory);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.title, "My: Résumé");
  assert.equal(result.files[0].name, "My Résumé.docx");
});

test("a document with no heading is named for its first line, without the comma after Dear Sam", async () => {
  const result = await makeDocument({ content: "Dear Sam,\n\nThank you for the books.\n\nBest wishes,\nAlex" }, fresh());
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.files[0].name, "Dear Sam.docx");
});

test("a file that is already there is never replaced: the new one takes the next number", async () => {
  const directory = fresh();
  const first = await makeDocument({ content: sample }, directory);
  const second = await makeDocument({ content: sample }, directory);
  const third = await makeDocument({ content: sample }, directory);
  assert.ok(first.ok && second.ok && third.ok);
  assert.deepEqual(readdirSync(directory).sort(), ["Quarterly Report (2).docx", "Quarterly Report (3).docx", "Quarterly Report.docx"]);
});

test("the files of one document share a number, even when only one of them was taken", async () => {
  const directory = fresh();
  await makeDocument({ content: sample, formats: ["pdf"] }, directory, { renderPdfsFn: printing(sampleLines) });
  const before = readFileSync(path.join(directory, "Quarterly Report.pdf"));
  const result = await makeDocument({ content: sample, formats: ["docx", "pdf"] }, directory, { renderPdfsFn: printing(sampleLines) });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.files.map((file) => file.name), ["Quarterly Report (2).docx", "Quarterly Report (2).pdf"]);
  assert.equal(existsSync(path.join(directory, "Quarterly Report.docx")), false, "the number was not spent on a lone Word file");
  assert.deepEqual(readFileSync(path.join(directory, "Quarterly Report.pdf")), before);
});

test("documents made at the same moment are never given the same name", async () => {
  const directory = fresh();
  const results = await Promise.all(Array.from({ length: 6 }, () => makeDocument({ content: sample, formats: ["docx", "pdf"] }, directory, { renderPdfsFn: printing(sampleLines) })));
  assert.ok(results.every((result) => result.ok));
  const names = results.flatMap((result) => (result.ok ? result.files.map((file) => file.name) : []));
  assert.equal(new Set(names).size, 12, names.join(", "));
  assert.equal(readdirSync(directory).length, 12);
});

test("a format that cannot be made is reported and the rest still are", async () => {
  const directory = fresh();
  const failing: typeof renderPdfs = async () => ({ ok: false, reason: "Electron exited with code 1.", rendered: 0 });
  const result = await makeDocument({ content: sample, formats: ["docx", "pdf"] }, directory, { renderPdfsFn: failing });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.files.map((file) => file.name), ["Quarterly Report.docx"]);
  assert.deepEqual(result.problems, ["The PDF could not be made: Electron exited with code 1."]);
  assert.deepEqual(readdirSync(directory), ["Quarterly Report.docx"], "no empty PDF is left behind");
  const told = describeMadeDocument(result, (absolute) => path.basename(absolute));
  assert.match(told, /Quarterly Report\.docx \(Word document\)/);
  assert.match(told, /Note: The PDF could not be made: Electron exited with code 1\./);
});

test("when nothing can be made, it is a failure and nothing is left in the folder", async () => {
  const directory = fresh();
  const failing: typeof renderPdfs = async () => ({ ok: false, reason: "Electron is not installed.", rendered: 0 });
  const result = await makeDocument({ content: sample, formats: ["pdf"] }, directory, { renderPdfsFn: failing });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /The PDF could not be made: Electron is not installed\./);
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(describeMadeDocument(result), `${(result as { reason: string }).reason} Nothing was made.`);
});

test("a PDF that cannot be read back is removed, not handed over", async () => {
  const directory = fresh();
  const brokenPdf: typeof renderPdfs = async (jobs) => { for (const job of jobs) writeFileSync(job.outputPath, "%PDF-1.4\nthis is not a real document\n"); return { ok: true, rendered: jobs.length }; };
  const result = await makeDocument({ content: sample, formats: ["docx", "pdf"] }, directory, { renderPdfsFn: brokenPdf });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.files.map((file) => file.format), ["docx"]);
  assert.match(result.problems[0], /^The PDF could not be made: it was written but could not be read back \(.+\), so it was removed\.$/);
  assert.deepEqual(readdirSync(directory), ["Quarterly Report.docx"]);
});

test("a file that opens but does not show the document's words is kept and said so", async () => {
  const directory = fresh();
  const result = await makeDocument({ content: sample, formats: ["pdf"] }, directory, { renderPdfsFn: printing(["Something", "else entirely"]) });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.files[0].checked, false);
  assert.equal(existsSync(result.files[0].path), true);
  assert.match(result.problems[0], /Quarterly Report\.pdf opens, but its first and last words were not found/);
  assert.doesNotMatch(describeMadeDocument(result), /read each file back to check it/, "the all-clear is not given");
});

test("a PDF that is cut short, with the opening there and the end missing, is not passed", async () => {
  const result = await makeDocument({ content: sample, formats: ["pdf"] }, fresh(), { renderPdfsFn: printing(sampleLines.slice(0, 3)) });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.files[0].checked, false);
});

test("nor is one that has the end and not the beginning", async () => {
  const result = await makeDocument({ content: sample, formats: ["pdf"] }, fresh(), { renderPdfsFn: printing(sampleLines.slice(2)) });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.files[0].checked, false);
});

test("a printer that says it worked and wrote nothing, or wrote a file that is gone again, gives no file", async () => {
  const nothing: typeof renderPdfs = async (jobs) => ({ ok: true, rendered: jobs.length });
  const empty = await makeDocument({ content: sample, formats: ["docx", "pdf"] }, fresh(), { renderPdfsFn: nothing });
  assert.ok(empty.ok);
  if (empty.ok) {
    assert.deepEqual(empty.files.map((file) => file.format), ["docx"]);
    assert.match(empty.problems[0], /^The PDF could not be made: it was written but could not be read back \(The file is empty\), so it was removed\.$/);
  }
  const vanishing: typeof renderPdfs = async (jobs) => { for (const job of jobs) rmSync(job.outputPath); return { ok: true, rendered: jobs.length }; };
  const directory = fresh();
  const gone = await makeDocument({ content: sample, formats: ["pdf"] }, directory, { renderPdfsFn: vanishing });
  assert.equal(gone.ok, false);
  assert.match((gone as { reason: string }).reason, /The PDF could not be made: it was written but could not be opened again/);
  assert.deepEqual(readdirSync(directory), []);
});

test("Markdown is written with plain line ends and one at the finish, whatever it arrived with", async () => {
  const directory = fresh();
  const result = await makeDocument({ content: "# Title\r\n\r\nBody text.\r\n\r\n\r\n", formats: ["md"] }, directory);
  assert.ok(result.ok);
  assert.equal(readFileSync(path.join(directory, "Title.md"), "utf8"), "# Title\n\nBody text.\n");
});

test("no text, too much text, and a folder that cannot be made are each refused", async () => {
  const empty = await makeDocument({ content: "  \n\t\n" }, fresh());
  assert.deepEqual(empty, { ok: false, reason: "There was no text to make a document from.", problems: [] });
  const huge = await makeDocument({ content: "word ".repeat(70_000) }, fresh());
  assert.equal(huge.ok, false);
  assert.match((huge as { reason: string }).reason, /350,000 letters; a document can be up to 300,000/);
  const blocker = path.join(folder, "a-file-not-a-folder");
  writeFileSync(blocker, "x");
  const blocked = await makeDocument({ content: sample }, blocker);
  assert.equal(blocked.ok, false);
  assert.match((blocked as { reason: string }).reason, /^The folder could not be made/);
});

test("text sent with escaped newlines still becomes a document with its paragraphs", async () => {
  const directory = fresh();
  const result = await makeDocument({ content: "# Notes\\n\\nFirst paragraph here.\\n\\nSecond paragraph here." }, directory);
  assert.ok(result.ok);
  if (!result.ok) return;
  const read = await extractDocumentText(readFileSync(result.files[0].path), result.files[0].name);
  assert.ok(read.ok);
  if (read.ok) assert.deepEqual(read.text.split("\n").map((line) => line.trim()).filter(Boolean), ["Notes", "First paragraph here.", "Second paragraph here."]);
});

test("a Word file is told apart from a PDF in what is reported, with pages only where counted", async () => {
  const result = await makeDocument({ content: sample, formats: ["docx", "pdf", "txt"] }, fresh(), { renderPdfsFn: printing(sampleLines) });
  assert.ok(result.ok);
  const told = describeMadeDocument(result, (absolute) => `documents/${path.basename(absolute)}`);
  assert.equal(told, [
    'Made "Quarterly Report", 18 words, and read each file back to check it:',
    "- documents/Quarterly Report.docx (Word document)",
    "- documents/Quarterly Report.pdf (PDF, 1 page)",
    "- documents/Quarterly Report.txt (text file)"
  ].join("\n"));
});
