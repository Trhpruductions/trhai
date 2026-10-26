import { parseMarkdown, plainText, type Align, type Block, type Inline } from "./markdown.js";
import { fits } from "./slideMetrics.js";

// A slide deck from the text a model writes for one: a Markdown outline. The first
// "#" heading is the deck's title (with the lines under it as its subtitle), and
// every "##" heading starts a slide. What is under a heading - bullets, numbered
// steps, a table, a quote, a few lines of code - is what is on the slide, and a
// paragraph that begins "Notes:" starts the speaker's notes for it. A slide that
// has more than will fit is split into two, with the title carried over, because
// text that runs off the bottom of a slide is the commonest way for a made deck to
// look made by a machine.

export type Bullet = { inlines: Inline[]; level: number; number: number | null; task: boolean };

export type SlideContent =
  | { kind: "bullets"; items: Bullet[] }
  | { kind: "text"; inlines: Inline[] }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "code"; lines: string[] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][]; align: Align[] };

/** `notes` are the speaker's, one paragraph to a line; they are not shown on the slide. */
export type Slide =
  | { kind: "title"; title: string; subtitle: string | null; notes: string[] }
  | { kind: "content"; title: string; content: SlideContent[]; notes: string[] };

/** `notes` is how many slides have speaker's notes, and `split` how many slides were added by splitting ones that were too full. */
export type Deck = { title: string; slides: Slide[]; notes: number; split: number };

export const mostSlides = 200;

/** The most outline one presentation is made from: some thirty thousand words. */
export const longestOutline = 200_000;

// ---------------------------------------------------------------- reading the outline

// "Note:" alone is left as a sentence a slide may begin with.
const notesLead = /^(?:speaker\s+notes?|notes)\s*:\s*/i;
const notesHeading = /^(?:speaker\s+)?notes?\s*:?$/i;

function bulletsOf(block: Extract<Block, { kind: "list" }>, level: number, out: Bullet[]): void {
  block.items.forEach((item, index) => {
    out.push({ inlines: item.inlines, level: Math.min(level, 2), number: block.ordered ? block.start + index : null, task: Boolean(item.task) && !block.ordered });
    for (const child of item.children) {
      if (child.kind === "list") bulletsOf(child, level + 1, out);
      else if (child.kind === "paragraph") out.push({ inlines: child.inlines, level: Math.min(level + 1, 2), number: null, task: false });
    }
  });
}

/** The text of a block as lines a speaker reads. */
function linesOf(block: Block): string[] {
  switch (block.kind) {
    case "paragraph": case "heading": return [plainText(block.inlines)];
    case "list": {
      const out: string[] = [];
      const walk = (list: Extract<Block, { kind: "list" }>, depth: number) => list.items.forEach((item, index) => {
        out.push(`${"  ".repeat(depth)}${list.ordered ? `${list.start + index}.` : "-"} ${plainText(item.inlines)}`);
        for (const child of item.children) { if (child.kind === "list") walk(child, depth + 1); else out.push(...linesOf(child)); }
      });
      walk(block, 0);
      return out;
    }
    case "quote": return block.blocks.flatMap(linesOf);
    case "code": return block.text.split("\n");
    case "table": return [block.header, ...block.rows].map((row) => row.map((cell) => plainText(cell)).join(" | "));
    default: return [];
  }
}

/**
 * Whether a "#" heading names the whole deck - the title slide, with a line or two of subtitle under it - rather
 * than being the first slide's own title, as it is when a model writes every slide under a "#" heading: that is
 * when what follows is a list, a table, code or a lot of text.
 */
function namesTheDeck(blocks: Block[], at: number): boolean {
  let paragraphs = 0;
  for (let index = at + 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.kind === "heading" && block.level <= 2) break;
    if (block.kind === "paragraph" && notesLead.test(plainText(block.inlines))) break;
    if (block.kind === "heading" && notesHeading.test(plainText(block.inlines))) break;
    if (block.kind === "list" || block.kind === "table" || block.kind === "code") return false;
    if (block.kind === "paragraph" && (paragraphs += 1) > 3) return false;
  }
  return true;
}

/** Read a Markdown outline into slides, or say why it cannot be one. `title` is used when the outline has none of its own. */
export function parseDeck(source: string, title?: string): { ok: true; deck: Deck } | { ok: false; reason: string } {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return { ok: false, reason: "There was no outline to make a presentation from." };

  const slides: Slide[] = [];
  let deckTitle = title?.replace(/\s+/g, " ").trim() || "";
  let current: Slide | undefined;
  let inNotes = false;
  const start = (next: Slide): Slide => { slides.push(next); return next; };

  for (const [index, block] of blocks.entries()) {
    if (block.kind === "heading" && block.level <= 2) {
      inNotes = false;
      const text = plainText(block.inlines);
      if (block.level === 1 && slides.length === 0 && namesTheDeck(blocks, index)) {
        deckTitle = text || deckTitle;
        current = start({ kind: "title", title: deckTitle, subtitle: null, notes: [] });
      } else {
        current = start({ kind: "content", title: text, content: [], notes: [] });
      }
      continue;
    }
    if (block.kind === "rule" || block.kind === "pagebreak") continue;

    // Speaker's notes run to the next slide: a paragraph that begins "Notes:", or a heading that says it.
    if (block.kind === "paragraph" && notesLead.test(plainText(block.inlines))) {
      inNotes = true;
      const first = plainText(block.inlines).replace(notesLead, "").trim();
      if (current && first) current.notes.push(first);
      continue;
    }
    if (block.kind === "heading" && notesHeading.test(plainText(block.inlines))) { inNotes = true; continue; }
    if (inNotes) { if (current) current.notes.push(...linesOf(block).filter((line) => line.trim() !== "")); continue; }

    if (!current) current = start({ kind: "content", title: "", content: [], notes: [] });
    if (current.kind === "title") {
      // What comes straight after the title is its subtitle; anything more starts a slide of its own.
      const line = block.kind === "paragraph" ? plainText(block.inlines) : block.kind === "quote" ? block.blocks.map((inner) => (inner.kind === "paragraph" ? plainText(inner.inlines) : "")).filter(Boolean).join(" ") : null;
      if (line !== null) { current.subtitle = current.subtitle === null ? line : `${current.subtitle}\n${line}`; continue; }
      current = start({ kind: "content", title: "", content: [], notes: [] });
    }
    const target = current;
    if (target.kind !== "content") continue;
    switch (block.kind) {
      case "heading": target.content.push({ kind: "text", inlines: block.inlines.map((run) => (run.kind === "text" ? { ...run, bold: true } : run)) }); break;
      case "paragraph": target.content.push({ kind: "text", inlines: block.inlines }); break;
      case "list": { const items: Bullet[] = []; bulletsOf(block, 0, items); target.content.push({ kind: "bullets", items }); break; }
      case "quote": for (const inner of block.blocks) if (inner.kind === "paragraph") target.content.push({ kind: "quote", inlines: inner.inlines }); break;
      case "code": target.content.push({ kind: "code", lines: block.text.split("\n") }); break;
      case "table": target.content.push({ kind: "table", header: block.header, rows: block.rows, align: block.align }); break;
      default: break;
    }
  }

  // A deck begins with a title slide; one that was given a title and has none of its own gets one.
  if (slides[0]?.kind !== "title" && deckTitle) slides.unshift({ kind: "title", title: deckTitle, subtitle: null, notes: [] });
  if (slides.length === 0) return { ok: false, reason: "There were no slides in that outline." };
  if (!deckTitle) deckTitle = slides[0].title || "Presentation";
  const fit = fitted(slides);
  if (fit.length > mostSlides) return { ok: false, reason: `That comes to ${fit.length} slides; a presentation can be up to ${mostSlides}.` };
  return { ok: true, deck: { title: deckTitle, slides: fit, notes: fit.filter((slide) => slide.notes.length > 0).length, split: fit.length - slides.length } };
}

// ---------------------------------------------------------------- making what is on a slide fit

/**
 * Cut what is too long for one slide into pieces that are not: a list between its items, a table between its
 * rows (with its header on each piece), code between its lines. A paragraph is left whole.
 */
function pieces(content: SlideContent): SlideContent[] {
  if (fits([content])) return [content];
  const cut = <Part>(all: Part[], make: (part: Part[]) => SlideContent): SlideContent[] => {
    const out: SlideContent[] = [];
    let part: Part[] = [];
    for (const one of all) {
      if (part.length > 0 && !fits([make([...part, one])])) { out.push(make(part)); part = []; }
      part.push(one);
    }
    if (part.length > 0) out.push(make(part));
    return out;
  };
  switch (content.kind) {
    case "bullets": return cut(content.items, (items) => ({ kind: "bullets", items }));
    case "table": return cut(content.rows, (rows) => ({ ...content, rows }));
    case "code": return cut(content.lines, (lines) => ({ kind: "code", lines }));
    default: return [content];
  }
}

/** Split what will not fit on one slide into slides of their own, the title carried over: "Plan", "Plan (2)". */
function fitted(slides: Slide[]): Slide[] {
  const out: Slide[] = [];
  for (const slide of slides) {
    if (slide.kind === "title") { out.push(slide); continue; }
    const groups: SlideContent[][] = [];
    let group: SlideContent[] = [];
    for (const piece of slide.content.flatMap(pieces)) {
      if (group.length > 0 && !fits([...group, piece])) { groups.push(group); group = []; }
      group.push(piece);
    }
    groups.push(group);
    // The speaker's notes stay with the first of the slides a long one is split into.
    groups.forEach((content, index) => out.push({ kind: "content", title: index === 0 ? slide.title : `${slide.title} (${index + 1})`, content, notes: index === 0 ? slide.notes : [] }));
  }
  return out;
}
