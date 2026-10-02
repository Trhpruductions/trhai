import { estimateTokens } from "./contextBudget.js";
import { splitLongPassage } from "./knowledgeStore.js";

// Summarizing a document too long for the model to read at once.
//
// The window holds about 15,000 tokens, and a 40-page PDF is three times that,
// so a summary asked of the model directly was a summary of the start and the
// end (see contextBudget). Here the document is read in sections the window
// can hold: the local model notes each one, keeping names, numbers and dates
// exactly, and the notes are combined - again in rounds, if there are many -
// into something one reply can hold. Every section is read; nothing is
// sampled or skipped below the cap.

/** One call to the local model with a prompt sent as written. */
export type GenerateText = (prompt: string) => Promise<{ ok: true; text: string; model?: string } | { ok: false; reason: string }>;

/** About what one section may hold, leaving the window room for the prompt and the notes. */
export const sectionTokens = 2400;
/** The most sections read for one summary: about 60,000 tokens, longer than the knowledge base keeps. */
export const maxSections = 24;
/** Below this a document is handed over whole: the model can read it in one go. */
export const directTokens = 3000;
/** The notes are combined until they fit in about this much. */
const combinedTokens = 3000;

/** The text cut into sections of at most `maxTokens` estimated tokens, on paragraph and sentence boundaries. */
export function splitIntoSections(text: string, maxTokens = sectionTokens): string[] {
  const pieces = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).flatMap(splitLongPassage);
  const sections: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const piece of pieces) {
    const tokens = estimateTokens(piece);
    if (current.length > 0 && currentTokens + tokens > maxTokens) {
      sections.push(current.join("\n\n"));
      current = [];
      currentTokens = 0;
    }
    current.push(piece);
    currentTokens += tokens;
  }
  if (current.length > 0) sections.push(current.join("\n\n"));
  return sections;
}

function sectionPrompt(title: string, focus: string, index: number, total: number, section: string): string {
  const lines = [`You are taking notes on part ${index + 1} of ${total} of the document "${title}".`];
  if (focus) {
    lines.push(`The reader wants to know about: ${focus}. Note what this part says about that; if it says nothing about it, write "Nothing on this here."`);
  }
  lines.push(
    "Write 3 to 6 short bullet points covering what this part says.",
    "Keep names, numbers, amounts and dates exactly as written. Do not add anything that is not in the text, and do not comment on the document.",
    "",
    "---",
    section,
    "---"
  );
  return lines.join("\n");
}

function combinePrompt(title: string, focus: string, notes: string): string {
  const lines = [`These are notes on consecutive parts of the document "${title}".`];
  if (focus) lines.push(`The reader wants to know about: ${focus}.`);
  lines.push(
    "Combine them into one set of bullet points, in the document's order, removing repetition.",
    "Keep names, numbers, amounts and dates exactly as written. Add nothing that is not in the notes.",
    "",
    "---",
    notes,
    "---"
  );
  return lines.join("\n");
}

export type Summary = { ok: true; notes: string; sections: number; read: number } | { ok: false; reason: string };

/**
 * Notes on the whole of a long text, section by section, combined to fit.
 * `read` is how many sections were read; it is less than `sections` only when
 * the text is longer than maxSections, and the caller says so.
 */
export async function summarizeLongText(
  text: string,
  options: { title: string; focus?: string; generate: GenerateText; onSection?: (done: number, total: number) => void }
): Promise<Summary> {
  const focus = (options.focus ?? "").trim();
  const sections = splitIntoSections(text);
  if (sections.length === 0) return { ok: false, reason: "There is no text to summarize." };
  const used = sections.slice(0, maxSections);

  const notes: string[] = [];
  for (const [index, section] of used.entries()) {
    const result = await options.generate(sectionPrompt(options.title, focus, index, used.length, section));
    if (!result.ok) return { ok: false, reason: `The summary stopped at part ${index + 1} of ${used.length}: ${result.reason}` };
    notes.push(result.text.trim());
    options.onSection?.(index + 1, used.length);
  }

  // Combined in rounds until one reply can hold them; two rounds cover the cap.
  let combined = notes.join("\n\n");
  for (let round = 0; round < 2 && estimateTokens(combined) > combinedTokens; round += 1) {
    const groups = splitIntoSections(combined, sectionTokens);
    const merged: string[] = [];
    for (const group of groups) {
      const result = await options.generate(combinePrompt(options.title, focus, group));
      if (!result.ok) return { ok: false, reason: `The summary stopped while combining the notes: ${result.reason}` };
      merged.push(result.text.trim());
    }
    combined = merged.join("\n\n");
  }

  return { ok: true, notes: combined, sections: sections.length, read: used.length };
}

/** Whether a text is short enough to hand to the model whole rather than in sections. */
export function readableAtOnce(text: string): boolean {
  return estimateTokens(text) <= directTokens;
}

function summaryPrompt(title: string, focus: string, source: string, fromNotes: boolean): string {
  const lines = [fromNotes
    ? `These are notes taken on every part of the document "${title}", in order.`
    : `This is the whole of the document "${title}".`];
  if (focus) lines.push(`The reader wants to know about: ${focus}.`);
  lines.push(
    `Write a summary of it: two or three sentences saying what it is and its main point, then the key points as a short bulleted list in the document's order.`,
    "Keep names, numbers, amounts and dates exactly as written. Add nothing that is not in the text.",
    "",
    "---",
    source,
    "---"
  );
  return lines.join("\n");
}

export type WrittenSummary = { ok: true; text: string; model?: string } | { ok: false; reason: string };

/**
 * A finished summary of a document, read in full: whole when it is short, in
 * sections when it is long, then written up from what was read. Says so when
 * the document is longer than one summary covers.
 */
export async function summarizeDocument(
  title: string,
  body: string,
  options: { focus?: string; generate: GenerateText; onSection?: (done: number, total: number) => void }
): Promise<WrittenSummary> {
  const focus = (options.focus ?? "").trim();
  let source = body.trim();
  let note = "";
  if (!source) return { ok: false, reason: `"${title}" is empty, so there is nothing to summarize.` };
  if (!readableAtOnce(source)) {
    const read = await summarizeLongText(source, { title, focus, generate: options.generate, onSection: options.onSection });
    if (!read.ok) return read;
    source = read.notes;
    if (read.read < read.sections) {
      note = `\n\n_This covers the first ${read.read} of the document's ${read.sections} parts - it is longer than one summary reads._`;
    }
  }
  const written = await options.generate(summaryPrompt(title, focus, source, source !== body.trim()));
  if (!written.ok) return { ok: false, reason: `The summary could not be written: ${written.reason}` };
  return { ok: true, text: `${written.text.trim()}${note}`, ...(written.model ? { model: written.model } : {}) };
}
