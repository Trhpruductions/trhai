import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deckHtml } from "./deckHtml.js";
import { longestOutline, parseDeck, type Deck, type Slide, type SlideContent } from "./deckData.js";
import { documentSource, folded, systemLocale } from "./documentMaker.js";
import { extractDocumentText, readSlides, type ReadSlide } from "./documentText.js";
import { withoutForbiddenCharacters } from "./docxWriter.js";
import { renderPdfs } from "./frameRenderer.js";
import { claimNames, fileStem } from "./madeFileNames.js";
import { plainText } from "./markdown.js";
import { pptxFile, splitContent } from "./pptxWriter.js";

// Presentations made on request: a PowerPoint file, a PDF of its slides, or both, from an
// outline the assistant writes in Markdown (deckData.ts reads it into slides).
//
// Every file is read back and compared with what was meant to be in it: a PowerPoint file
// slide by slide - every word of the slide and of its speaker's notes - and a PDF by its page
// for every slide and the words on each.

export const presentationFormats = ["pptx", "pdf"] as const;
export type PresentationFormat = (typeof presentationFormats)[number];

export const presentationFormatNames: Record<PresentationFormat, string> = { pptx: "PowerPoint presentation", pdf: "PDF" };

const formatWords: Array<[RegExp, PresentationFormat]> = [
  [/^(?:pptx?|powerpoint|power-?point|slides?|slideshow|slide-?show|deck|presentation|presentations|keynote|msppt|ms-?powerpoint|microsoft)$/, "pptx"],
  [/^(?:pdf|pdfs|pdf-?files?|adobe)$/, "pdf"]
];

/** The formats asked for, as a model words them: "pptx", "PowerPoint", "powerpoint and pdf". Nothing asked for is PowerPoint. */
export function parsePresentationFormats(value: unknown): { ok: true; formats: PresentationFormat[] } | { ok: false; reason: string } {
  const given = Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : value === undefined || value === null ? [] : null;
  if (given === null) return { ok: false, reason: "format must be pptx or pdf, or a list of them." };
  // "Power Point" and "slide show" are one word each, said with a space (said with a hyphen, the words below take them).
  const tokens = given.flatMap((entry) => entry.toLowerCase().replace(/power\s+point/g, "powerpoint").replace(/slide\s+show/g, "slideshow").replace(/^\.+/, "").split(/[\s,;/&+]+|\band\b/).map((word) => word.replace(/^\.+/, "")).filter(Boolean));
  const formats: PresentationFormat[] = [];
  for (const token of tokens) {
    if (/^(?:a|an|the|file|files|document|documents|format|both|as|in|also|or|then|page|pages)$/.test(token)) continue;
    const match = formatWords.find(([pattern]) => pattern.test(token));
    if (!match) return { ok: false, reason: `"${token}" is not a format I can make a presentation in. I can make pptx (PowerPoint presentation) and pdf (PDF).` };
    if (!formats.includes(match[1])) formats.push(match[1]);
  }
  return { ok: true, formats: formats.length > 0 ? formats : ["pptx"] };
}

// ---------------------------------------------------------------- what a slide should read back as

/** The lines of text on a slide, in the order the file puts them: its title, what is above its tables, the tables, what is below. */
export function slideLines(slide: Slide): string[] {
  const out: string[] = [];
  if (slide.title) out.push(slide.title);
  if (slide.kind === "title") {
    if (slide.subtitle) out.push(...slide.subtitle.split("\n"));
    return out;
  }
  const add = (items: SlideContent[]) => {
    for (const item of items) {
      switch (item.kind) {
        case "bullets": for (const bullet of item.items) out.push(plainText(bullet.inlines)); break;
        case "text": case "quote": out.push(plainText(item.inlines)); break;
        case "code": out.push(...item.lines); break;
        case "table": for (const cell of item.header) out.push(plainText(cell)); for (const row of item.rows) for (const cell of row) out.push(plainText(cell)); break;
      }
    }
  };
  const { texts, tables, tail } = splitContent(slide.content);
  add(texts);
  add(tables);
  add(tail);
  return out;
}

/** The words of some lines, which are the same words however they are broken into lines. */
const wordsOf = (lines: string[]): string[] => lines.join(" ").split(/\s+/).filter(Boolean);

/** Where two lists of words first differ, as the few words around it, or null when they are the same. */
function differenceBetween(wanted: string[], found: string[]): { wanted: string; found: string } | null {
  let at = 0;
  while (at < wanted.length && at < found.length && wanted[at] === found[at]) at += 1;
  if (at === wanted.length && at === found.length) return null;
  const around = (words: string[]) => words.slice(Math.max(0, at - 2), at + 4).join(" ") || "nothing";
  return { wanted: around(wanted), found: around(found) };
}

/** The first thing a PowerPoint file's slides read back as that is not what was written, as a sentence, or null when all of them are. */
function firstDifference(slides: Slide[], read: ReadSlide[]): string | null {
  if (read.length !== slides.length) return `it has ${read.length} slides where ${slides.length} were written`;
  for (const [index, slide] of slides.entries()) {
    const label = `slide ${index + 1}${slide.title ? ` ("${slide.title.slice(0, 40)}")` : ""}`;
    const text = differenceBetween(wordsOf(slideLines(slide)), wordsOf([read[index].text]));
    if (text) return `${label} was written as "${text.wanted}" and read back as "${text.found}"`;
    const notes = differenceBetween(wordsOf(slide.notes), wordsOf([read[index].notes]));
    if (notes) return `the speaker's notes on ${label} were written as "${notes.wanted}" and read back as "${notes.found}"`;
  }
  return null;
}

/** The lines on a deck's slides that are running text, which a PDF reader returns in order (table cells and code it may weave together). */
function runningLines(slides: Slide[]): string[] {
  const out: string[] = [];
  for (const slide of slides) {
    if (slide.title) out.push(slide.title);
    if (slide.kind === "title") { if (slide.subtitle) out.push(...slide.subtitle.split("\n")); continue; }
    const { texts, tail } = splitContent(slide.content);
    for (const item of [...texts, ...tail]) {
      if (item.kind === "bullets") out.push(...item.items.map((bullet) => plainText(bullet.inlines)));
      else if (item.kind === "text" || item.kind === "quote") out.push(plainText(item.inlines));
    }
  }
  return out.filter((line) => folded(line) !== "");
}

/** The first thing a PDF of the slides does not show: a page for each slide, and the start of every line of text. */
function firstGap(slides: Slide[], read: { text: string; pages?: number }): string | null {
  if (read.pages !== undefined && read.pages !== slides.length) return `it has ${read.pages} page${read.pages === 1 ? "" : "s"} for ${slides.length} slide${slides.length === 1 ? "" : "s"}`;
  const text = folded(read.text);
  const lines = runningLines(slides);
  for (const line of lines) {
    const start = folded(line).slice(0, 24);
    if (!text.includes(start)) return `the words "${line.slice(0, 40)}" were not found when it was read back`;
  }
  const last = folded(lines[lines.length - 1] ?? "").slice(-24);
  if (last && !text.includes(last)) return `the end of the last slide, "${(lines[lines.length - 1] ?? "").slice(-40)}", was not found when it was read back`;
  return null;
}

// ---------------------------------------------------------------- making one

export type PresentationRequest = {
  /** The outline: a "#" heading for the title, a "##" heading for each slide, what is on the slide under it. */
  content: string;
  title?: string;
  /** Nothing asked for is PowerPoint. */
  formats?: PresentationFormat[];
  language?: string;
};

export type MadePresentationFile = {
  format: PresentationFormat;
  name: string;
  path: string;
  bytes: number;
  /** A PDF's pages, as they were counted on reading it back. */
  pages?: number;
  /** Whether it was read back and found to be what was meant. */
  checked: boolean;
};

export type MakePresentationResult =
  | { ok: true; title: string; slides: number; notes: number; split: number; files: MadePresentationFile[]; problems: string[] }
  | { ok: false; reason: string; problems: string[] };

export type MakePresentationOptions = {
  now?: Date;
  /** Printing to PDF takes the desktop's own Electron; a test hands in a stand-in. */
  renderPdfsFn?: typeof renderPdfs;
  /** For a test to hand in a writer that gets something wrong, to see that the check notices. */
  writePptx?: typeof pptxFile;
};

const fileSize = (file: string): number => {
  try { return statSync(file).size; } catch { return 0; }
};

/** The bytes of a file just written, or why they cannot be had: a program that guards the folder can take a file as soon as it is there. */
function readBack(file: string): { ok: true; bytes: Buffer } | { ok: false; reason: string } {
  try {
    return { ok: true, bytes: readFileSync(file) };
  } catch (error) {
    return { ok: false, reason: `it was written but could not be opened again (${error instanceof Error ? error.message : String(error)}).` };
  }
}

/**
 * Text with the control characters a file made of XML cannot hold taken out, before it is read as an outline, so that what
 * is on a slide is what every file shows. A vertical tab or form feed is a break between words, and is a space; the rest
 * (a NUL, a bell) are dropped.
 */
const printable = (text: string): string => withoutForbiddenCharacters(text.replace(/[\v\f]/g, " "));

/** Make a presentation into `directory`, in every format asked for, and say what was made. */
export async function makePresentation(request: PresentationRequest, directory: string, options: MakePresentationOptions = {}): Promise<MakePresentationResult> {
  const source = printable(documentSource(request.content));
  if (!source.trim()) return { ok: false, reason: "There was no outline to make a presentation from.", problems: [] };
  if (source.length > longestOutline) {
    return { ok: false, reason: `That is ${source.length.toLocaleString("en-US")} letters; a presentation can be made from up to ${longestOutline.toLocaleString("en-US")}.`, problems: [] };
  }
  const given = request.title === undefined ? undefined : printable(request.title);
  const read = parseDeck(source, given);
  if (!read.ok) return { ok: false, reason: read.reason, problems: [] };
  const deck: Deck = read.deck;
  const title = given?.replace(/\s+/g, " ").trim().slice(0, 200) || deck.title.slice(0, 200);
  const formats = request.formats && request.formats.length > 0 ? [...new Set(request.formats)] : (["pptx"] as PresentationFormat[]);
  const language = request.language ?? systemLocale();

  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `The folder could not be made: ${error instanceof Error ? error.message : String(error)}.`, problems: [] };
  }
  let claimed: ReturnType<typeof claimNames<PresentationFormat>>;
  try {
    claimed = claimNames(directory, fileStem(title, "Presentation"), formats);
  } catch (error) {
    return { ok: false, reason: `Nothing could be written in that folder: ${error instanceof Error ? error.message : String(error)}.`, problems: [] };
  }
  if (!claimed) return { ok: false, reason: "There are too many files with that name already.", problems: [] };

  const problems: string[] = [];
  const files: MadePresentationFile[] = [];
  const giveUp = (format: PresentationFormat, reason: string) => {
    try { rmSync(claimed!.files.get(format)!, { force: true }); } catch { /* an empty claim is not worth a second failure */ }
    problems.push(`The ${presentationFormatNames[format]} could not be made: ${reason}`);
  };

  for (const format of formats) {
    const file = claimed.files.get(format)!;
    const name = path.basename(file);
    try {
      if (format === "pptx") {
        writeFileSync(file, (options.writePptx ?? pptxFile)(deck.slides, { title, author: "TRH AI", date: options.now }));
        const written = readBack(file);
        if (!written.ok) { giveUp(format, written.reason); continue; }
        let slidesRead: ReadSlide[];
        try {
          slidesRead = readSlides(written.bytes);
        } catch (error) {
          giveUp(format, `it was written but could not be read back (${(error instanceof Error ? error.message : String(error)).replace(/\.$/, "")}), so it was removed.`);
          continue;
        }
        const different = firstDifference(deck.slides, slidesRead);
        if (different) problems.push(`The PowerPoint presentation ${name}: ${different}; open it and look before relying on it.`);
        files.push({ format, name, path: file, bytes: fileSize(file), checked: different === null });
      } else {
        const printed = await (options.renderPdfsFn ?? renderPdfs)([{ index: 0, html: deckHtml(deck.slides, { title, language }), outputPath: file }], { timeoutMs: 180_000 });
        if (!printed.ok) { giveUp(format, printed.reason); continue; }
        const written = readBack(file);
        if (!written.ok) { giveUp(format, written.reason); continue; }
        const back = await extractDocumentText(written.bytes, name);
        if (!back.ok) { giveUp(format, `it was written but could not be read back (${back.reason.replace(/\.$/, "")}), so it was removed.`); continue; }
        const gap = firstGap(deck.slides, back);
        if (gap) problems.push(`The PDF ${name}: ${gap}; open it and look before sending it on.`);
        files.push({ format, name, path: file, bytes: fileSize(file), ...(back.pages !== undefined ? { pages: back.pages } : {}), checked: gap === null });
      }
    } catch (error) {
      giveUp(format, error instanceof Error ? error.message : String(error));
    }
  }

  if (files.length === 0) return { ok: false, reason: problems.join(" ") || "Nothing was made.", problems };
  return { ok: true, title, slides: deck.slides.length, notes: deck.notes, split: deck.split, files, problems };
}

/** What to tell the person, from what was made: each file by where it is. */
export function describeMadePresentation(result: MakePresentationResult, show: (absolute: string) => string = (absolute) => absolute): string {
  if (!result.ok) return `${result.reason} Nothing was made.`;
  const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;
  const lines = result.files.map((file) => {
    const detail = [presentationFormatNames[file.format], file.format === "pdf" && file.pages !== undefined ? plural(file.pages, "page") : plural(result.slides, "slide")].join(", ");
    return `- ${show(file.path)} (${detail})`;
  });
  const checked = result.files.every((file) => file.checked);
  const what = [plural(result.slides, "slide"), result.notes > 0 ? `${plural(result.notes, "slide")} with speaker notes` : null].filter(Boolean).join(", ");
  return [
    `Made "${result.title}", ${what}${checked ? ", and read each file back to check every slide" : ""}:`,
    ...lines,
    ...(result.split > 0 ? [`Note: ${plural(result.split, "slide")} ${result.split === 1 ? "was" : "were"} added because some of the slides had more on them than fits on one; each is named after the slide it continues, like "Plan (2)".`] : []),
    ...result.problems.map((problem) => `Note: ${problem}`)
  ].join("\n");
}
