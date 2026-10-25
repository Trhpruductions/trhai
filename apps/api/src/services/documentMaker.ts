import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { docxFile } from "./docxWriter.js";
import { claimNames, fileStem } from "./madeFileNames.js";
import { documentHtml, type Paper } from "./documentHtml.js";
import { extractDocumentText } from "./documentText.js";
import { renderPdfs } from "./frameRenderer.js";
import { firstHeading, parseMarkdown, plainText, type Block, type Inline } from "./markdown.js";

// Documents made on request: a Word file, a PDF, a web page, Markdown or plain
// text, from one piece of Markdown. The text is read once into blocks
// (markdown.ts), and each format draws the same blocks its own way, so the Word
// file and the PDF of one document agree.
//
// Nothing is reported that was not checked. Every file is read back with the
// same reader TRH AI uses on documents it is given, and the document's own
// opening and closing words have to be found in what comes back; a file that
// cannot be read back is removed, and one that reads but does not show those
// words is kept, with that said.

export { fileStem };

export const documentFormats = ["docx", "pdf", "html", "md", "txt"] as const;
export type DocumentFormat = (typeof documentFormats)[number];

export const documentFormatNames: Record<DocumentFormat, string> = {
  docx: "Word document",
  pdf: "PDF",
  html: "web page",
  md: "Markdown file",
  txt: "text file"
};

/** Where documents go in the workspace unless the request says otherwise. */
export const documentsFolder = "documents";

/** The most text one document is made from: some fifty thousand words. */
export const longestDocument = 300_000;

const formatWords: Array<[RegExp, DocumentFormat]> = [
  [/^(?:docx?|word|msword|ms-?word|word-?documents?|word-?files?)$/, "docx"],
  [/^(?:pdf|pdfs|pdf-?files?|adobe)$/, "pdf"],
  [/^(?:html?|web|webpage|web-?pages?|website|web-?site)$/, "html"],
  [/^(?:md|markdown)$/, "md"],
  [/^(?:txt|text|plain|plaintext|plain-?text|text-?files?|notepad)$/, "txt"]
];

/**
 * The formats asked for, as a model words them: "docx", "Word", "pdf and word",
 * ["docx", "pdf"]. A name that is none of them is refused with the ones that
 * exist, instead of being guessed at. Nothing asked for is Word, the one that
 * can still be edited.
 */
export function parseDocumentFormats(value: unknown): { ok: true; formats: DocumentFormat[] } | { ok: false; reason: string } {
  const given = Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : value === undefined || value === null ? [] : null;
  if (given === null) return { ok: false, reason: `format must be one of ${documentFormats.join(", ")}, or a list of them.` };
  const tokens = given.flatMap((entry) => entry.toLowerCase().replace(/^\.+/, "").split(/[\s,;/&+]+|\band\b/).map((word) => word.replace(/^\.+/, "")).filter(Boolean));
  if (tokens.length === 0) return { ok: true, formats: ["docx"] };
  const formats: DocumentFormat[] = [];
  for (const token of tokens) {
    // "a", "the" and "file" between the names are filler, not a format that does not exist.
    if (/^(?:a|an|the|file|files|document|documents|format|both|as|in|also|or|then|page|pages)$/.test(token)) continue;
    const match = formatWords.find(([pattern]) => pattern.test(token));
    if (!match) return { ok: false, reason: `"${token}" is not a format I can make. I can make ${documentFormats.map((format) => `${format} (${documentFormatNames[format]})`).join(", ")}.` };
    if (!formats.includes(match[1])) formats.push(match[1]);
  }
  return formats.length > 0 ? { ok: true, formats } : { ok: true, formats: ["docx"] };
}

const lettersRegions = new Set(["US", "CA", "MX", "GT", "SV", "HN", "NI", "CR", "PA", "DO", "CO", "VE", "CL", "PH", "BO", "PR", "GU", "VI", "AS", "MP"]);

/** The paper a place uses: Letter where it does, A4 everywhere else. */
export function paperForLocale(locale: string | undefined): Paper {
  try {
    const region = new Intl.Locale(locale ?? "").maximize().region;
    return region && lettersRegions.has(region) ? "Letter" : "A4";
  } catch {
    return "A4";
  }
}

/** This computer's own locale, as the paper and the spell checker should see it. */
export function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

// ---------------------------------------------------------------- the text

/**
 * The text of a model's reply to "write the document", made safe to read as
 * Markdown. A model that was shown a one-line example sometimes sends the
 * newlines as the two letters backslash and n; with none of the real ones
 * anywhere in it, that is what they are.
 */
export function documentSource(content: string): string {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const escaped = text.match(/\\n/g)?.length ?? 0;
  if (!text.includes("\n") && escaped >= 2) return text.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, "    ");
  return text;
}

const spoken = (inlines: Inline[]): string => {
  const out: string[] = [];
  for (let index = 0; index < inlines.length; index += 1) {
    const run = inlines[index];
    if (run.kind === "break") { out.push("\n"); continue; }
    out.push(run.text);
    // The address of a link goes after the last of its words, where a reader of plain text can use it.
    const next = inlines[index + 1];
    const href = run.href;
    if (href && !(next && next.kind === "text" && next.href === href) && /^(?:https?:\/\/|mailto:|tel:)/i.test(href.trim()) && run.text.trim() !== href.trim()) out.push(` (${href.trim()})`);
  }
  return out.join("");
};

const cellText = (inlines: Inline[]): string => plainText(inlines);

function tableLines(block: Extract<Block, { kind: "table" }>): string[] {
  const rows = [block.header.map(cellText), ...block.rows.map((row) => row.map(cellText))];
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) => Math.min(48, Math.max(3, ...rows.map((row) => (row[column] ?? "").length))));
  const place = (text: string, column: number) => {
    const width = widths[column];
    const cut = text.length > width ? `${text.slice(0, width - 1)}…` : text;
    const align = block.align[column];
    return align === "right" ? cut.padStart(width) : align === "center" ? cut.padStart(Math.floor((width + cut.length) / 2)).padEnd(width) : cut.padEnd(width);
  };
  const line = (row: string[]) => Array.from({ length: columns }, (_, column) => place(row[column] ?? "", column)).join(" | ").trimEnd();
  return [line(rows[0]), widths.map((width) => "-".repeat(width)).join("-+-"), ...rows.slice(1).map(line)];
}

function textLines(blocks: Block[]): string[] {
  const lines: string[] = [];
  const gap = () => { if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push(""); };
  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        gap();
        const text = spoken(block.inlines);
        lines.push(text);
        if (block.level <= 2) lines.push((block.level === 1 ? "=" : "-").repeat(Math.max(3, Math.min(72, text.length))));
        lines.push("");
        break;
      }
      case "paragraph":
        gap();
        lines.push(...spoken(block.inlines).split("\n"), "");
        break;
      case "list": {
        gap();
        block.items.forEach((item, index) => {
          const marker = block.ordered ? `${block.start + index}.` : "-";
          const body = spoken(item.inlines).split("\n");
          lines.push(`${marker} ${body[0]}`, ...body.slice(1).map((more) => `${" ".repeat(marker.length + 1)}${more}`));
          for (const child of textLines(item.children)) lines.push(child === "" ? "" : `${" ".repeat(marker.length + 1)}${child}`);
        });
        gap();
        break;
      }
      case "code":
        gap();
        lines.push(...block.text.split("\n").map((line) => `    ${line}`), "");
        break;
      case "table":
        gap();
        lines.push(...tableLines(block), "");
        break;
      case "quote":
        gap();
        lines.push(...textLines(block.blocks).map((line) => (line === "" ? ">" : `> ${line}`)), "");
        break;
      case "rule":
        gap();
        lines.push("-".repeat(40), "");
        break;
      case "pagebreak":
        gap();
        break;
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The document as plain text: headings underlined, lists with their marks, tables in columns, link addresses written out. */
export function plainTextDocument(blocks: Block[]): string {
  return textLines(blocks).join("\r\n") + "\r\n";
}

/**
 * The words of a document that are text, in order, one entry for each block that has some.
 * `prose` leaves out table cells and code, whose lines a PDF reader may weave together.
 */
function textsOf(blocks: Block[], prose = false): string[] {
  const out: string[] = [];
  const add = (text: string) => { if (text.trim()) out.push(text); };
  for (const block of blocks) {
    switch (block.kind) {
      case "heading": case "paragraph": add(plainText(block.inlines)); break;
      case "list": for (const item of block.items) { add(plainText(item.inlines)); out.push(...textsOf(item.children, prose)); } break;
      case "code": if (!prose) for (const line of block.text.split("\n")) add(line); break;
      case "table": if (!prose) { for (const cell of block.header) add(plainText(cell)); for (const row of block.rows) for (const cell of row) add(plainText(cell)); } break;
      case "quote": out.push(...textsOf(block.blocks, prose)); break;
      default: break;
    }
  }
  return out;
}

/** What a reader compares: letters and numbers only, folded, so a space or a bullet drawn differently is not a difference. */
const folded = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * The first and last words of a document, as short strings that must turn up in any file made from it. Taken from
 * the running text where there is some: a table cell that wraps in a narrow column is read back with its lines
 * mixed in with the next column's, and that is not the file being wrong.
 */
export function edgeWords(blocks: Block[]): { first: string; last: string } {
  const running = textsOf(blocks, true).map(folded).filter(Boolean);
  const texts = running.length > 0 ? running : textsOf(blocks).map(folded).filter(Boolean);
  if (texts.length === 0) return { first: "", last: "" };
  return { first: texts[0].slice(0, 28), last: texts[texts.length - 1].slice(-28) };
}

/** How many words a document has: counted the way the language is written, so a Chinese page is not one word. */
export function countWords(blocks: Block[]): number {
  const text = textsOf(blocks).join("\n");
  try {
    let count = 0;
    for (const part of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) if (part.isWordLike) count += 1;
    return count;
  } catch {
    return text.split(/\s+/).filter(Boolean).length;
  }
}

// ---------------------------------------------------------------- the names

/** The title when the request gave none: the first heading, else the first line of the text, else a plain "Document". */
export function titleOf(blocks: Block[], given?: string): string {
  const own = given?.replace(/\s+/g, " ").trim();
  if (own) return own.slice(0, 200);
  const heading = firstHeading(blocks);
  if (heading) return heading.slice(0, 200);
  // A salutation or a first sentence makes a poor title with its punctuation on the end of it.
  const first = textsOf(blocks)[0]?.replace(/[\s.,;:!?-]+$/g, "");
  if (first && first.length <= 60) return first;
  if (first) {
    const cut = first.slice(0, 57);
    const space = cut.lastIndexOf(" ");
    return `${(space >= 30 ? cut.slice(0, space) : cut).trimEnd()}...`;
  }
  return "Document";
}

// ---------------------------------------------------------------- making one

export type DocumentRequest = {
  /** The document, written in Markdown. */
  content: string;
  title?: string;
  /** Nothing asked for is Word. */
  formats?: DocumentFormat[];
  /** Nothing asked for is the paper this computer's own place uses. */
  paper?: Paper;
  language?: string;
};

export type MadeDocumentFile = {
  format: DocumentFormat;
  /** The file's own name: Quarterly Report.docx */
  name: string;
  /** Where it is, whole. */
  path: string;
  bytes: number;
  /** A PDF's pages, as they were counted on reading it back. */
  pages?: number;
  /** Whether it was read back and the document's first and last words were found in it. */
  checked: boolean;
};

export type MakeDocumentResult =
  | { ok: true; title: string; words: number; files: MadeDocumentFile[]; problems: string[] }
  | { ok: false; reason: string; problems: string[] };

export type MakeDocumentOptions = {
  /** Printing to PDF takes the desktop's own Electron; a test hands in a stand-in. */
  renderPdfsFn?: typeof renderPdfs;
  now?: Date;
};

const fileSize = (file: string): number => {
  try { return statSync(file).size; } catch { return 0; }
};

/** Whether what a reader found in a file shows the document's own beginning and end. */
function showsTheEdges(found: string, edges: { first: string; last: string }): boolean {
  const text = folded(found);
  if (!edges.first) return true;
  return text.includes(edges.first) && text.includes(edges.last);
}

/**
 * Make a document into `directory`, in every format asked for, and say what
 * was made. Files are named for the title and never replace one that is
 * already there. A format that cannot be made is reported, and the rest are
 * still made; only when none can is the whole request a failure.
 */
export async function makeDocument(request: DocumentRequest, directory: string, options: MakeDocumentOptions = {}): Promise<MakeDocumentResult> {
  const source = documentSource(request.content);
  if (!source.trim()) return { ok: false, reason: "There was no text to make a document from.", problems: [] };
  if (source.length > longestDocument) {
    return { ok: false, reason: `That is ${source.length.toLocaleString("en-US")} letters; a document can be up to ${longestDocument.toLocaleString("en-US")}.`, problems: [] };
  }
  const blocks = parseMarkdown(source);
  const title = titleOf(blocks, request.title);
  const formats = request.formats && request.formats.length > 0 ? [...new Set(request.formats)] : (["docx"] as DocumentFormat[]);
  const language = request.language ?? systemLocale();
  const paper = request.paper ?? paperForLocale(language);
  const edges = edgeWords(blocks);

  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `The folder could not be made: ${error instanceof Error ? error.message : String(error)}.`, problems: [] };
  }

  let claimed: ReturnType<typeof claimNames<DocumentFormat>>;
  try {
    claimed = claimNames(directory, fileStem(title), formats);
  } catch (error) {
    return { ok: false, reason: `Nothing could be written in that folder: ${error instanceof Error ? error.message : String(error)}.`, problems: [] };
  }
  if (!claimed) return { ok: false, reason: "There are too many files with that name already.", problems: [] };

  const files: MadeDocumentFile[] = [];
  const problems: string[] = [];
  const giveUp = (format: DocumentFormat, reason: string) => {
    const file = claimed!.files.get(format)!;
    try { rmSync(file, { force: true }); } catch { /* an empty claim is not worth a second failure */ }
    problems.push(`The ${documentFormatNames[format]} could not be made: ${reason}`);
  };

  const html = formats.includes("pdf") || formats.includes("html") ? documentHtml(blocks, { title, paper, language }) : "";

  for (const format of formats) {
    const file = claimed.files.get(format)!;
    const name = path.basename(file);
    if (format === "pdf") continue;
    try {
      const data: Buffer | string =
        format === "docx" ? docxFile(blocks, { title, author: "TRH AI", paper, language, date: options.now })
        : format === "html" ? html
        : format === "md" ? `${source.replace(/\r\n?/g, "\n").replace(/\n+$/g, "")}\n`
        : plainTextDocument(blocks);
      writeFileSync(file, data);
      files.push({ format, name, path: file, bytes: fileSize(file), checked: false });
    } catch (error) {
      giveUp(format, error instanceof Error ? error.message : String(error));
    }
  }

  if (formats.includes("pdf")) {
    const file = claimed.files.get("pdf")!;
    const printed = await (options.renderPdfsFn ?? renderPdfs)([{ index: 0, html, outputPath: file }], { timeoutMs: 180_000 });
    if (printed.ok) files.push({ format: "pdf", name: path.basename(file), path: file, bytes: fileSize(file), checked: false });
    else giveUp("pdf", printed.reason);
  }

  // Read every file back, as a person opening it would.
  for (const made of [...files]) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(made.path);
    } catch (error) {
      // Gone as soon as it was written: a program that guards the folder can do that.
      files.splice(files.indexOf(made), 1);
      giveUp(made.format, `it was written but could not be opened again (${error instanceof Error ? error.message : String(error)}).`);
      continue;
    }
    if (made.format === "docx" || made.format === "pdf") {
      const read = await extractDocumentText(bytes, made.name);
      if (!read.ok) {
        files.splice(files.indexOf(made), 1);
        giveUp(made.format, `it was written but could not be read back (${read.reason.replace(/\.$/, "")}), so it was removed.`);
        continue;
      }
      made.checked = showsTheEdges(read.text, edges);
      if (read.pages !== undefined) made.pages = read.pages;
      if (!made.checked) problems.push(`The ${documentFormatNames[made.format]} ${made.name} opens, but its first and last words were not found when it was read back; open it and look before sending it on.`);
    } else {
      made.checked = made.bytes === bytes.length && made.bytes > 0;
      if (!made.checked) problems.push(`The ${documentFormatNames[made.format]} ${made.name} is not the size it was written at; open it and look.`);
    }
  }

  if (files.length === 0) {
    return { ok: false, reason: problems.length > 0 ? problems.join(" ") : "Nothing was made.", problems };
  }
  // Same order as asked.
  files.sort((a, b) => formats.indexOf(a.format) - formats.indexOf(b.format));
  return { ok: true, title, words: countWords(blocks), files, problems };
}

/**
 * What to tell the person, from what was made: each file by where it is, in
 * the words they would use. `show` names a path the way the person sees it
 * (inside the workspace, the short one).
 */
export function describeMadeDocument(result: MakeDocumentResult, show: (absolute: string) => string = (absolute) => absolute): string {
  if (!result.ok) return `${result.reason} Nothing was made.`;
  const lines = result.files.map((file) => {
    const detail = [documentFormatNames[file.format], file.pages !== undefined ? `${file.pages} page${file.pages === 1 ? "" : "s"}` : null].filter(Boolean).join(", ");
    return `- ${show(file.path)} (${detail})`;
  });
  const checked = result.files.every((file) => file.checked);
  return [
    `Made "${result.title}", ${result.words.toLocaleString("en-US")} word${result.words === 1 ? "" : "s"}${checked ? ", and read each file back to check it" : ""}:`,
    ...lines,
    ...result.problems.map((problem) => `Note: ${problem}`)
  ].join("\n");
}
