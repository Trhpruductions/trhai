import { inflateRawSync } from "node:zlib";
import path from "node:path";

// The text inside a document file: PDF, Word, PowerPoint, or plain text.
//
// So a document the user has can be read - added to the knowledge base, or
// opened by read_file - instead of being refused as binary. Everything runs
// on this machine. PDFs go through pdf.js (by way of unpdf, which bundles it
// with no further dependencies); Word and PowerPoint files are zip archives
// of XML, and the few lines of zip reading they need are here rather than a
// library, because the parts read are always the same two or three.

export type DocumentKind = "pdf" | "docx" | "pptx" | "text";

export type ExtractedText =
  | { ok: true; kind: DocumentKind; text: string; pages?: number }
  | { ok: false; reason: string };

/** The largest document file read for its text. */
export const maxDocumentBytes = 40 * 1024 * 1024;

const textExtensions = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".xml", ".yml", ".yaml", ".html", ".htm", ".rtf"]);

/** The kind of document a file is, from its first bytes first and its name second. */
export function documentKind(bytes: Uint8Array, fileName: string): DocumentKind | null {
  const extension = path.extname(fileName).toLowerCase();
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return "pdf";
  const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (zip && extension === ".docx") return "docx";
  if (zip && extension === ".pptx") return "pptx";
  if (textExtensions.has(extension)) return "text";
  return null;
}

/** Whether read_file should read a path as a document rather than as text. */
export function isDocumentPath(fileName: string): boolean {
  return [".pdf", ".docx", ".pptx"].includes(path.extname(fileName).toLowerCase());
}

/**
 * The files inside a zip archive, by name, inflated on demand.
 *
 * Only what Office files use: the central directory, stored and deflated
 * entries. Zip64 and encryption are refused by name rather than misread.
 */
export function readZip(bytes: Buffer): Map<string, () => Buffer> {
  // The end-of-central-directory record is in the last 64 KiB plus its own 22 bytes.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (bytes.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error("this is not a complete zip archive");
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  if (at === 0xffffffff || count === 0xffff) throw new Error("archives this large (zip64) are not supported");

  const entries = new Map<string, () => Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error("the archive's directory is damaged");
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localHeader = bytes.readUInt32LE(at + 42);
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    entries.set(name, () => {
      if (flags & 0x1) throw new Error("the document is password-protected");
      if (bytes.readUInt32LE(localHeader) !== 0x04034b50) throw new Error("the archive is damaged");
      const start = localHeader + 30 + bytes.readUInt16LE(localHeader + 26) + bytes.readUInt16LE(localHeader + 28);
      const data = bytes.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`the archive uses a compression method (${method}) Office files do not`);
    });
  }
  return entries;
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
    }
    return entities[code.toLowerCase()] ?? whole;
  });
}

/** Blank lines kept to one, trailing spaces gone. */
function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The text of a Word document's body: paragraphs as lines, table cells as tabs. */
export function docxText(documentXml: string): string {
  const cellBreak = "\u0001";
  const marked = documentXml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n")
    // Every table cell holds paragraphs of its own; there they are lines of
    // the cell, not passages, or each cell would start a new block.
    .replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (cell) => cell.replace(/<\/w:p>/g, cellBreak))
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tbl>/g, "\n")
    // A paragraph ends with a blank line, so the knowledge base finds the
    // passages in it (see chunkDocument).
    .replace(/<\/w:p>/g, "\n\n");
  // Only the text runs: everything else in the XML is formatting.
  const text = marked
    .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<[^>]+>/g, (_tag, run: string | undefined) => run ?? "")
    .replace(new RegExp(`${cellBreak}(?=\\t)`, "g"), "")
    .replace(new RegExp(cellBreak, "g"), " ");
  return tidy(decodeEntities(text));
}

/** The text of one PowerPoint slide: each paragraph on its own line. */
export function slideText(slideXml: string): string {
  const marked = slideXml.replace(/<\/a:p>/g, "\n").replace(/<a:br\b[^>]*\/>/g, "\n");
  const text = marked.replace(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<[^>]+>/g, (_tag, run: string | undefined) => run ?? "");
  return tidy(decodeEntities(text));
}

/** Readable text from an HTML page: no tags, scripts or styles. */
export function htmlText(html: string): string {
  const text = html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeEntities(text));
}

async function pdfText(bytes: Buffer): Promise<ExtractedText> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // A copy: pdf.js takes ownership of the array it is given.
  const document = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { totalPages, text } = await extractText(document, { mergePages: false });
    // Pages joined by a blank line, so a page is at least one passage.
    const joined = tidy(text.map((page) => page.trim()).filter(Boolean).join("\n\n"));
    if (!joined) {
      return {
        ok: false,
        reason: "This PDF has no text in it - it is most likely scanned pages, which are pictures of text. "
          + "Reading those needs text recognition, which TRH AI does not do yet."
      };
    }
    return { ok: true, kind: "pdf", text: joined, pages: totalPages };
  } finally {
    // pdf.js frees the parsed document here; unpdf's bundled types leave the
    // method out, so it is reached through a narrower shape.
    await (document as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}

/** The text of a document file, or why it could not be read. */
export async function extractDocumentText(bytes: Buffer, fileName: string): Promise<ExtractedText> {
  if (bytes.length === 0) return { ok: false, reason: "The file is empty." };
  if (bytes.length > maxDocumentBytes) {
    return { ok: false, reason: `The file is ${Math.round(bytes.length / 1024 / 1024)} MB; documents up to ${maxDocumentBytes / 1024 / 1024} MB can be read.` };
  }
  const kind = documentKind(bytes, fileName);
  try {
    switch (kind) {
      case "pdf":
        return await pdfText(bytes);
      case "docx": {
        const body = readZip(bytes).get("word/document.xml");
        if (!body) return { ok: false, reason: "This .docx has no document body in it." };
        const text = docxText(body().toString("utf8"));
        return text ? { ok: true, kind, text } : { ok: false, reason: "This Word document has no text in it." };
      }
      case "pptx": {
        const zip = readZip(bytes);
        const slides = [...zip.keys()]
          .map((name) => ({ name, number: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1]) }))
          .filter((entry) => Number.isFinite(entry.number))
          .sort((a, b) => a.number - b.number);
        const text = slides
          .map(({ name, number }) => {
            const content = slideText(zip.get(name)!().toString("utf8"));
            return content ? `Slide ${number}\n${content}` : "";
          })
          .filter(Boolean)
          .join("\n\n");
        return text ? { ok: true, kind, text, pages: slides.length } : { ok: false, reason: "This presentation has no text in it." };
      }
      case "text": {
        const raw = bytes.toString("utf8").replace(/^﻿/, "");
        const extension = path.extname(fileName).toLowerCase();
        const text = extension === ".html" || extension === ".htm" ? htmlText(raw) : tidy(raw);
        return text ? { ok: true, kind, text } : { ok: false, reason: "The file has no text in it." };
      }
      default:
        return {
          ok: false,
          reason: `"${path.basename(fileName) || "That file"}" is not a kind of document TRH AI can read. `
            + "It reads PDF, Word (.docx), PowerPoint (.pptx) and plain-text files."
        };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `That document could not be read: ${detail}.` };
  }
}
